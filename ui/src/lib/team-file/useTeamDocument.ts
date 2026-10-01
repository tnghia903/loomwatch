import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import { MarkerType, type Connection, type Edge, type EdgeChange, type NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentNode } from '../library/nodeFromDrop'
import { nodeFromDrop } from '../library/nodeFromDrop'
import { fetchConfigSchema, fetchTeamFile, fetchTeamsDiscovery, saveTeamFile, TeamFileApiError } from './client'
import { TeamFileModel, TeamFileParseError } from './document'
import { type EdgeRefusal, validateConfiguredEdge } from './edgeRules'
import { autoLayout, offsetCollision, seededLayout } from './layout'
import { pipelineOrder, type PipelineStep } from './pipelineOrder'
import type { AgentConfig, BriefEntryConfig, BudgetConfig, CapabilityRef, EdgeConfig, GuardsConfig, ScheduleConfig, SpawnConfig, TeamDocument } from './types'
import {
  loadTeamValidator,
  displayFieldProblems,
  type AgentField,
  type DocumentProblem,
  type TeamValidator,
  type ValidationResult,
} from './validation'

export type ConfiguredEdge = Edge<{ kind: EdgeConfig['kind']; ts: string }>

export type SaveState =
  | 'no-file'
  | 'new'
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'invalid'
  | 'conflict'
  | 'read-only'
  | 'error'

/** docs/CANVAS_SPEC.md §8: a consequence of `edges`, never a setting the UI can flip directly. */
export type ExecutionMode = 'team' | 'pipeline'

/** §8.3: the last-edge deletion is applied immediately, then offered a 5s undo window. */
export interface PendingEdgeRemoval {
  edges: EdgeConfig[]
  /** The final edge disappeared as part of a node deletion, so Undo restores that whole edit. */
  restoreDocument?: boolean
}

export interface ExternalChange {
  diskYaml: string
  diskRevision: string
}

export interface LoadFailure {
  message: string
  line: string | null
}

interface HistoryEntry {
  yaml: string
  positions: Record<string, { x: number; y: number }>
  isNew: boolean
}

const EXTERNAL_CHANGE_MESSAGE =
  'This team file changed on disk while you had unsaved edits. Reload it before saving.'

async function hashTeamYaml(yaml: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(yaml))
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sourceLineAtError(source: string, lineNumber: number): string | null {
  const lines = source.split(/\r?\n/)
  const atError = lines[lineNumber - 1]
  if (atError?.trim()) return atError
  // YAML often reports an unclosed collection at the following empty EOF line. In that case,
  // show the preceding non-empty line that actually needs the operator's attention.
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    if (lines[index]?.trim()) return lines[index]
  }
  return atError ?? null
}

function parseFailure(error: TeamFileParseError, source: string): LoadFailure {
  const lineNumber = Number(error.message.match(/(?:at )?line (\d+)/i)?.[1])
  const line = lineNumber > 0
    ? sourceLineAtError(source, lineNumber)
    : error.message.match(/line \d+[^;]*/i)?.[0] ?? null
  return { message: error.message, line }
}

/** Resolve a daemon-approved relative team path against its canonical discovery root. */
export function absoluteTeamPath(root: string, requestedPath: string): string {
  if (requestedPath.startsWith('/')) return requestedPath
  const parts: string[] = []
  for (const part of requestedPath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new Error('Team path escapes the configured teams directory.')
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) throw new Error('Team path does not name a file.')
  return `${root.replace(/\/+$/, '')}/${parts.join('/')}`
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

export function slugifyTeamName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'new-team'
  )
}

function edgeFromConfig(edge: EdgeConfig): ConfiguredEdge {
  return {
    id: edgeId(edge.from, edge.to),
    type: 'configured',
    source: edge.from,
    target: edge.to,
    data: { kind: edge.kind, ts: edge.ts },
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-stroke)', width: 14, height: 14 },
    ariaLabel: `sequence from ${edge.from} to ${edge.to}`,
  }
}

/**
 * The agents and configured edges a snapshot draws. `edges` is a serde default in the daemon
 * (`config.rs`), so a file without it is a team with no connections, not a broken one, and a
 * half-written team may have no `agents` yet. Validation still reads the snapshot itself, so the
 * schema's view of either omission is shown as a problem rather than hidden.
 */
function drawableParts(snapshot: TeamDocument): { agents: AgentConfig[]; configured: EdgeConfig[] } {
  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    configured: Array.isArray(snapshot.edges) ? snapshot.edges.filter((edge) => edge.layer === 'configured') : [],
  }
}

/**
 * Fills in what the daemon defaults when a file leaves it out (`config.rs` `RawAgent` and
 * `SpawnConfig`): an empty `name` and `role`, and no `spawn.args` or `spawn.env`. An agent the daemon
 * accepts must be one the canvas can draw — harness detection compares `args` as a list and the card
 * reads `role` as text, and a file that left either out blanked the workspace. The schema still
 * requires them, and validation reads the snapshot rather than these nodes, so the file is still
 * shown as needing a fix.
 */
function withDaemonDefaults(agent: AgentConfig): AgentConfig {
  const { spawn } = agent
  return {
    ...agent,
    name: agent.name ?? '',
    role: agent.role ?? '',
    ...(spawn ? { spawn: { ...spawn, args: Array.isArray(spawn.args) ? spawn.args : [], env: spawn.env ?? {} } } : {}),
  }
}

function nodeFromAgent(
  config: AgentConfig,
  position: { x: number; y: number },
  isEntrypoint: boolean,
): AgentNode {
  const agent = withDaemonDefaults(config)
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
 * save. Node positions are not part of the team file (docs/CANVAS_SPEC.md §7.3, decided in ADR
 * 0016: they live in the `<team>.layout.json` sidecar), so drags never touch the model; only
 * agent/edge/entrypoint content does. The sidecar's positions arrive through `applyPositions`,
 * which is also not a dirtying edit — see its doc comment.
 *
 * New teams use the daemon's existing relative-path PUT support: the document remains in memory
 * until its first agent makes it valid, then the first explicit save creates `<slug>.yaml` below
 * the configured teams root (§10.2).
 */
export function useTeamDocument() {
  const saveInFlightRef = useRef(false)
  const modelRef = useRef<TeamFileModel | null>(null)
  const loadedRevisionRef = useRef<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [teamsRoot, setTeamsRoot] = useState<string | null>(null)
  const [nodes, setNodes] = useState<AgentNode[]>([])
  const [edges, setEdges] = useState<ConfiguredEdge[]>([])
  const [entrypoint, setEntrypointState] = useState<string | null>(null)
  const [teamGuards, setTeamGuards] = useState<GuardsConfig | null>(null)
  const [teamBudget, setTeamBudget] = useState<BudgetConfig | null>(null)
  const [teamSchedule, setTeamSchedule] = useState<ScheduleConfig | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('no-file')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<EdgeRefusal | null>(null)
  const [modeSwitchBanner, setModeSwitchBanner] = useState(false)
  const [pendingEdgeRemoval, setPendingEdgeRemoval] = useState<PendingEdgeRemoval | null>(null)
  const [validator, setValidator] = useState<TeamValidator | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(true)
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(new Set())
  const [attemptedSave, setAttemptedSave] = useState(false)
  const [documentSnapshot, setDocumentSnapshot] = useState<ReturnType<TeamFileModel['snapshot']> | null>(null)
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null)
  const [fileGone, setFileGone] = useState(false)
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null)
  const [externalChange, setExternalChange] = useState<ExternalChange | null>(null)
  const [diskNotice, setDiskNotice] = useState<string | null>(null)
  const [yamlPreview, setYamlPreview] = useState('')
  /** The bytes last read from or written to disk, so the chip can state a magnitude (§9.1). */
  const [loadedYaml, setLoadedYaml] = useState<string | null>(null)
  const isNewRef = useRef(false)
  const undoRef = useRef<HistoryEntry[]>([])
  const redoRef = useRef<HistoryEntry[]>([])
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 })

  useEffect(() => {
    if (!['new', 'dirty', 'invalid', 'conflict', 'saving', 'error'].includes(saveState)) return
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [saveState])

  const resetHistory = useCallback(() => {
    undoRef.current = []
    redoRef.current = []
    setHistoryState({ undo: 0, redo: 0 })
  }, [])

  const currentHistoryEntry = useCallback((): HistoryEntry | null => {
    if (!modelRef.current) return null
    return {
      yaml: modelRef.current.toYaml(),
      positions: Object.fromEntries(nodes.map((node) => [node.id, node.position])),
      isNew: isNewRef.current,
    }
  }, [nodes])

  const captureHistory = useCallback(() => {
    const entry = currentHistoryEntry()
    if (!entry) return
    undoRef.current.push(entry)
    redoRef.current = []
    setHistoryState({ undo: undoRef.current.length, redo: 0 })
  }, [currentHistoryEntry])

  const restoreHistoryEntry = useCallback((entry: HistoryEntry) => {
    const model = TeamFileModel.parse(entry.yaml)
    const snapshot = model.snapshot()
    const { agents, configured } = drawableParts(snapshot)
    modelRef.current = model
    isNewRef.current = entry.isNew
    setDocumentSnapshot(snapshot)
    setYamlPreview(entry.yaml)
    setEntrypointState(snapshot.entrypoint || null)
    setTeamGuards(snapshot.guards ?? null)
    setTeamBudget(snapshot.budget ?? null)
    setTeamSchedule(snapshot.schedule ?? null)
    setTeamSchedule(snapshot.schedule ?? null)
    setNodes(
      agents.map((agent) =>
        nodeFromAgent(agent, entry.positions[agent.id] ?? { x: 0, y: 0 }, agent.id === snapshot.entrypoint),
      ),
    )
    setEdges(configured.map(edgeFromConfig))
    setSaveState(entry.isNew ? 'new' : 'dirty')
  }, [])

  const undo = useCallback(() => {
    const prior = undoRef.current.pop()
    const current = currentHistoryEntry()
    if (!prior || !current) return
    redoRef.current.push(current)
    restoreHistoryEntry(prior)
    setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length })
  }, [currentHistoryEntry, restoreHistoryEntry])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    const current = currentHistoryEntry()
    if (!next || !current) return
    undoRef.current.push(current)
    restoreHistoryEntry(next)
    setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length })
  }, [currentHistoryEntry, restoreHistoryEntry])

  const markDirty = useCallback(() => {
    setDocumentSnapshot(modelRef.current?.snapshot() ?? null)
    setYamlPreview(modelRef.current?.toYaml() ?? '')
    setSaveState((current) => {
      if (current === 'no-file' || current === 'read-only') return current
      return isNewRef.current ? 'new' : 'dirty'
    })
  }, [])

  const createNewDocument = useCallback((name: string, filePath?: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = slugifyTeamName(trimmed)
    const model = TeamFileModel.create(id, trimmed)
    modelRef.current = model
    loadedRevisionRef.current = null
    isNewRef.current = true
    // The caller may pass a path that does not collide with an existing file; the default is the
    // slug, which a save then refuses if that file already exists.
    setPath(filePath ?? `${id}.yaml`)
    setNodes([])
    setEdges([])
    setEntrypointState(null)
    setTeamGuards(null)
    setTeamBudget(null)
    setTeamSchedule(null)
    setDocumentSnapshot(model.snapshot())
    setYamlPreview(model.toYaml())
    setLoadedYaml(null)
    setSaveError(null)
    setReadOnlyReason(null)
    setFileGone(false)
    setLoadFailure(null)
    setExternalChange(null)
    setAttemptedSave(false)
    setSaveState('new')
    resetHistory()
  }, [resetHistory])

  useEffect(() => {
    const requestedPath = new URLSearchParams(window.location.search).get('path')
    let cancelled = false

    async function load() {
      if (!requestedPath) {
        try {
          const schema = await fetchConfigSchema()
          const nextValidator = await loadTeamValidator(schema)
          if (!cancelled) setValidator(() => nextValidator)
        } catch {
          // Client validation is a courtesy; the daemon still validates every PUT.
        } finally {
          if (!cancelled) setSchemaLoading(false)
        }
        return
      }
      let source: string | null = null
      try {
        const [{ yaml, revision }, discovery] = await Promise.all([
          fetchTeamFile(requestedPath),
          requestedPath.startsWith('/') ? Promise.resolve(null) : fetchTeamsDiscovery(),
        ])
        source = yaml
        const loadedRevision = revision ?? await hashTeamYaml(yaml)
        if (cancelled) {
          return
        }
        const model = TeamFileModel.parse(yaml)
        const snapshot = model.snapshot()
        const { agents, configured } = drawableParts(snapshot)
        const positions = seededLayout(
          agents.map((agent) => agent.id),
          configured.map((edge) => ({ from: edge.from, to: edge.to })),
          snapshot.id,
        )
        modelRef.current = model
        loadedRevisionRef.current = loadedRevision
        isNewRef.current = false
        if (discovery) setTeamsRoot(discovery.root)
        setPath(discovery ? absoluteTeamPath(discovery.root, requestedPath) : requestedPath)
        setEntrypointState(snapshot.entrypoint)
        setTeamGuards(snapshot.guards ?? null)
        setTeamBudget(snapshot.budget ?? null)
        setTeamSchedule(snapshot.schedule ?? null)
        setTeamSchedule(snapshot.schedule ?? null)
        setNodes(
          agents.map((agent) =>
            nodeFromAgent(agent, positions[agent.id] ?? { x: 0, y: 0 }, agent.id === snapshot.entrypoint),
          ),
        )
        setEdges(configured.map(edgeFromConfig))
        setDocumentSnapshot(snapshot)
        setYamlPreview(yaml)
        setLoadedYaml(yaml)
        resetHistory()
        setFileGone(false)
        const schemaVersion = (snapshot as { schemaVersion?: unknown }).schemaVersion
        if (schemaVersion !== 1) {
          const reason = `This file uses schema version ${String(schemaVersion)}. This build of LoomWatch understands version 1.`
          setReadOnlyReason(reason)
          setSaveState('read-only')
        } else {
          setSaveState('clean')
        }
      } catch (error: unknown) {
        if (cancelled) {
          return
        }
        const message =
          error instanceof TeamFileApiError || error instanceof TeamFileParseError
            ? error.message
            : String(error)
        setSaveError(message)
        if (error instanceof TeamFileParseError) {
          setLoadFailure(parseFailure(error, source ?? ''))
        }
        setSaveState('error')
      }

      try {
        const schema = await fetchConfigSchema()
        const nextValidator = await loadTeamValidator(schema)
        if (!cancelled) setValidator(() => nextValidator)
      } catch {
        // Client validation is a courtesy; the daemon still validates every PUT.
      } finally {
        if (!cancelled) setSchemaLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [resetHistory])

  const applyDiskYaml = useCallback(
    async (yaml: string, notice?: string, revision?: string) => {
      let model: TeamFileModel
      try {
        model = TeamFileModel.parse(yaml)
      } catch (error) {
        if (error instanceof TeamFileParseError) {
          setLoadFailure(parseFailure(error, yaml))
          setSaveError(error.message)
          setSaveState('error')
          return false
        }
        throw error
      }
      const snapshot = model.snapshot()
      const { agents, configured } = drawableParts(snapshot)
      const positions = seededLayout(
        agents.map((agent) => agent.id),
        configured.map((edge) => ({ from: edge.from, to: edge.to })),
        snapshot.id,
      )
      const currentPositions = new Map(nodes.map((node) => [node.id, node.position]))
      modelRef.current = model
      loadedRevisionRef.current = revision ?? await hashTeamYaml(yaml)
      isNewRef.current = false
      setEntrypointState(snapshot.entrypoint)
      setTeamGuards(snapshot.guards ?? null)
      setTeamBudget(snapshot.budget ?? null)
      setTeamSchedule(snapshot.schedule ?? null)
      setTeamSchedule(snapshot.schedule ?? null)
      setNodes(
        agents.map((agent) =>
          nodeFromAgent(
            agent,
            currentPositions.get(agent.id) ?? positions[agent.id] ?? { x: 0, y: 0 },
            agent.id === snapshot.entrypoint,
          ),
        ),
      )
      setEdges(configured.map(edgeFromConfig))
      setDocumentSnapshot(snapshot)
      setYamlPreview(yaml)
      setLoadedYaml(yaml)
      resetHistory()
      setExternalChange(null)
      setSaveError(null)
      setLoadFailure(null)
      setFileGone(false)
      const schemaVersion = (snapshot as { schemaVersion?: unknown }).schemaVersion
      if (schemaVersion !== 1) {
        const reason = `This file uses schema version ${String(schemaVersion)}. This build of LoomWatch understands version 1.`
        setReadOnlyReason(reason)
        setSaveState('read-only')
      } else {
        setReadOnlyReason(null)
        setSaveState('clean')
      }
      if (notice) {
        setDiskNotice(notice)
        window.setTimeout(() => setDiskNotice((current) => (current === notice ? null : current)), 3000)
      }
      return true
    },
    [nodes, resetHistory],
  )

  const reloadFromDisk = useCallback(async () => {
    if (!path || isNewRef.current) return
    try {
      const { yaml, revision } = await fetchTeamFile(path)
      await applyDiskYaml(yaml, 'Reloaded from disk', revision)
    } catch (error) {
      if (error instanceof TeamFileApiError && error.status === 404) {
        const reason = 'File is gone. Save a copy to continue editing.'
        setReadOnlyReason(reason)
        setFileGone(true)
        setSaveError(reason)
        setSaveState('read-only')
        return
      }
      setSaveError(error instanceof Error ? error.message : String(error))
      setSaveState('error')
    }
  }, [path, applyDiskYaml])

  // §9.3: compare the loaded revision against disk and hand the difference to the conflict bar.
  // Polled on focus (intentionally weak but honest, until the daemon has revision events), and
  // called directly when `POST /api/runs` refuses a stale revision (§1.5).
  const checkDiskRevision = useCallback(async () => {
    const loadedRevision = loadedRevisionRef.current
    if (!path || !loadedRevision || isNewRef.current) return
    try {
      const { yaml, revision } = await fetchTeamFile(path)
      const diskRevision = revision ?? await hashTeamYaml(yaml)
      if (diskRevision === loadedRevision) return
      // §9.5: a read-only document cannot hold unsaved edits, so a changed disk revision is
      // not a conflict — re-evaluate it like a clean canvas (§9.3), which re-classifies the
      // new schemaVersion and may even lift the read-only state.
      if (saveState === 'clean' || saveState === 'saved' || saveState === 'read-only') {
        await applyDiskYaml(yaml, 'Reloaded from disk', revision)
      } else {
        setExternalChange({ diskYaml: yaml, diskRevision })
        setSaveError(EXTERNAL_CHANGE_MESSAGE)
        setSaveState('conflict')
      }
    } catch (error) {
      if (error instanceof TeamFileApiError && error.status === 404) {
        const reason = 'File is gone. Save a copy to continue editing.'
        setReadOnlyReason(reason)
        setFileGone(true)
        setSaveError(reason)
        setSaveState('read-only')
      }
    }
  }, [path, saveState, applyDiskYaml])

  useEffect(() => {
    const onFocus = () => void checkDiskRevision()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkDiskRevision])

  const keepMine = useCallback(() => {
    if (!externalChange) return
    isNewRef.current = false
    loadedRevisionRef.current = externalChange.diskRevision
    setExternalChange(null)
    setSaveError(null)
    setSaveState('dirty')
  }, [externalChange])

  const useDisk = useCallback(async () => {
    if (!externalChange) return
    await applyDiskYaml(externalChange.diskYaml, undefined, externalChange.diskRevision)
  }, [externalChange, applyDiskYaml])

  const saveCopy = useCallback(async (requestedPath: string) => {
    const targetPath = requestedPath.trim()
    if (!targetPath || !modelRef.current || saveInFlightRef.current) return false
    saveInFlightRef.current = true
    setSaveState('saving')
    try {
      const yaml = modelRef.current.toYaml()
      let root = teamsRoot
      if (!targetPath.startsWith('/') && !root) {
        const discovery = await fetchTeamsDiscovery()
        root = discovery.root
        setTeamsRoot(root)
      }
      const saved = await saveTeamFile(targetPath, yaml, null)
      const displayPath = root ? absoluteTeamPath(root, saved.path) : saved.path
      loadedRevisionRef.current = saved.revision ?? await hashTeamYaml(yaml)
      isNewRef.current = false
      setLoadedYaml(yaml)
      setPath(displayPath)
      setReadOnlyReason(null)
      setFileGone(false)
      setSaveError(null)
      setSaveState(modelRef.current.toYaml() === yaml ? 'saved' : 'dirty')
      window.history.replaceState({}, '', `/?path=${encodeURIComponent(displayPath)}`)
      window.setTimeout(() => setSaveState((current) => (current === 'saved' ? 'clean' : current)), 2000)
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      setSaveState('read-only')
      return false
    } finally {
      saveInFlightRef.current = false
    }
  }, [teamsRoot])

  // Batched so a multi-select delete (several 'remove' NodeChanges in one call) computes the
  // survivor set once, instead of each single-id removal racing the others over stale state.
  const removeAgents = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) {
        return
      }
      captureHistory()
      const idSet = new Set(ids)
      const remainingNodes = nodes.filter((node) => !idSet.has(node.id))
      const droppedEdges = edges.filter((edge) => idSet.has(edge.source) || idSet.has(edge.target))
      const remainingEdges = edges.filter((edge) => !idSet.has(edge.source) && !idSet.has(edge.target))
      const configuredResponder = documentSnapshot?.responder

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

      if (configuredResponder) {
        if (remainingEdges.length === 0 && nextEntrypoint) modelRef.current?.setResponder(nextEntrypoint)
        else if (idSet.has(configuredResponder)) modelRef.current?.clearResponder()
      }

      setNodes(remainingNodes.map((node) => ({ ...node, data: { ...node.data, isEntrypoint: node.id === nextEntrypoint } })))
      setEdges(remainingEdges)
      setEntrypointState(nextEntrypoint)
      markDirty()

      // Deleting a node also deletes every incident edge (§5.4). If that happens to remove
      // the final configured edge, it has the exact same execution-mode consequence as
      // deleting the edge itself, so retain the inline five-second undo affordance (§8.3).
      if (edges.length > 0 && remainingEdges.length === 0 && droppedEdges.length > 0) {
        setPendingEdgeRemoval({
          edges: droppedEdges.map((edge) => ({
            from: edge.source,
            to: edge.target,
            layer: 'configured',
            kind: edge.data?.kind ?? 'sequence',
            ts: edge.data?.ts ?? new Date().toISOString(),
          })),
          restoreDocument: true,
        })
      }
    },
    [nodes, edges, entrypoint, documentSnapshot?.responder, markDirty, captureHistory],
  )

  const removeAgent = useCallback((id: string) => removeAgents([id]), [removeAgents])

  const removeEdgesBetween = useCallback(
    (pairs: readonly { from: string; to: string }[]) => {
      if (pairs.length === 0) {
        return
      }
      captureHistory()
      const hadEdges = edges.length > 0
      const removed: EdgeConfig[] = []
      const remaining = edges.filter((edge) => {
        const match = pairs.some((pair) => pair.from === edge.source && pair.to === edge.target)
        if (match) {
          removed.push({ from: edge.source, to: edge.target, layer: 'configured', kind: edge.data?.kind ?? 'sequence', ts: edge.data?.ts ?? new Date().toISOString() })
        }
        return !match
      })

      pairs.forEach((pair) => modelRef.current?.removeEdge(pair.from, pair.to))
      if (remaining.length === 0 && documentSnapshot?.responder && entrypoint) modelRef.current?.setResponder(entrypoint)
      setEdges(remaining)
      markDirty()

      // §8.3: dropping the last edge reverts the team to self-organizing — that widens what
      // agents may do, so it gets a 5s undo window instead of taking effect silently.
      if (hadEdges && remaining.length === 0) {
        setPendingEdgeRemoval({ edges: removed })
      }
    },
    [edges, entrypoint, documentSnapshot?.responder, markDirty, captureHistory],
  )

  const removeEdgeBetween = useCallback(
    (from: string, to: string) => removeEdgesBetween([{ from, to }]),
    [removeEdgesBetween],
  )

  /**
   * Put the agent cards where the `<team>.layout.json` sidecar says they were left.
   *
   * Deliberately **not** a dirtying edit and deliberately not in the undo stack: these are the
   * positions this document already had, arriving from the sidecar a moment after the YAML. ADR
   * 0016 puts them there rather than in the team file, so restoring them is not a change to the
   * document the daemon runs — which is exactly what makes a drag never dirty the team file.
   *
   * An agent with no saved position keeps the seeded auto-layout, which is a normal state and not
   * an error: the same file opens the same shape on a machine that has never seen it.
   */
  const applyPositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      setNodes((current) => {
        let changed = false
        const next = current.map((node) => {
          const saved = positions[node.id]
          if (!saved || (saved.x === node.position.x && saved.y === node.position.y)) return node
          changed = true
          return { ...node, position: saved }
        })
        return changed ? next : current
      })
    },
    [],
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

      if (newNode.data.agent.kind === 'operator' && edges.length === 0) {
        window.dispatchEvent(new CustomEvent('loomwatch:placement-refused', { detail: 'Review stops need a pipeline. Connect two agents first, then add You.' }))
        return
      }
      captureHistory()
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
    [nodes, entrypoint, edges.length, markDirty, captureHistory],
  )

  const renameAgent = useCallback(
    (id: string, field: 'name' | 'role', value: string) => {
      captureHistory()
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
    [markDirty, captureHistory],
  )

  const updateAgentSpawn = useCallback((id: string, value: SpawnConfig) => {
    captureHistory()
    modelRef.current?.setAgentField(id, 'spawn', value)
    modelRef.current?.setAgentField(id, 'model', '')
    modelRef.current?.setAgentField(id, 'thinkingEffort', undefined)
    setNodes(current => current.map(node => node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, spawn: value, model: '', thinkingEffort: undefined } } } : node))
    markDirty()
  }, [markDirty, captureHistory])

  const updateAgentModel = useCallback(
    (id: string, value: string) => {
      captureHistory()
      modelRef.current?.setAgentField(id, 'model', value)
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, model: value } } } : node,
        ),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const updateAgentThinkingEffort = useCallback(
    (id: string, value: string) => {
      captureHistory()
      modelRef.current?.setAgentField(id, 'thinkingEffort', value)
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, thinkingEffort: value } } } : node,
        ),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const updateAgentCwd = useCallback(
    (id: string, cwd: string) => {
      captureHistory()
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id || node.data.agent.kind === 'operator') {
            return node
          }
          const spawn: SpawnConfig = { cmd: '', args: [], env: {}, ...node.data.agent.spawn, cwd }
          modelRef.current?.setAgentField(id, 'spawn', spawn)
          return { ...node, data: { ...node.data, agent: { ...node.data.agent, spawn } } }
        }),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const updateAgentBudget = useCallback(
    (id: string, limitUsd: number) => {
      captureHistory()
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id || node.data.agent.kind === 'operator') {
            return node
          }
          const budget = { ...node.data.agent.budget, limitUsd }
          modelRef.current?.setAgentField(id, 'budget', budget)
          return { ...node, data: { ...node.data, agent: { ...node.data.agent, budget } } }
        }),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const updateAgentWarnAt = useCallback(
    (id: string, warnAtPercent: number) => {
      captureHistory()
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id || node.data.agent.kind === 'operator') {
            return node
          }
          const budget = { limitUsd: 0, ...node.data.agent.budget, warnAtPercent }
          modelRef.current?.setAgentField(id, 'budget', budget)
          return { ...node, data: { ...node.data, agent: { ...node.data.agent, budget } } }
        }),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const updateAgentAllowRecruiting = useCallback(
    (id: string, allowRecruiting: boolean) => {
      captureHistory()
      modelRef.current?.setAgentField(id, 'allowRecruiting', allowRecruiting)
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, allowRecruiting } } } : node,
        ),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  /**
   * The Inspector's Behaviour-zone memory toggles: `memory.brief` and `memory.deliverAs`.
   *
   * Both are executable — they change what the daemon puts in the opening prompt and whether it
   * moves the agent into the managed workspace — so they go through the document model and wait
   * for an explicit save, like every other Behaviour field. Passing `undefined` clears the key,
   * which is how an agent goes back to inheriting the team's `memory:` block.
   */
  const updateAgentMemory = useCallback(
    (id: string, field: 'brief' | 'deliverAs', value: boolean | 'native-file' | 'packet-only' | undefined) => {
      captureHistory()
      modelRef.current?.setAgentMemory(id, field, value)
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) return node
          const memory: NonNullable<AgentConfig['memory']> = { ...node.data.agent.memory }
          if (value === undefined) delete memory[field]
          else if (field === 'brief') memory.brief = value as boolean
          else memory.deliverAs = value as 'native-file' | 'packet-only'
          const next = Object.keys(memory).length > 0 ? memory : undefined
          return { ...node, data: { ...node.data, agent: { ...node.data.agent, memory: next } } }
        }),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  /**
   * Wiring a capability to an agent is a change to what the daemon runs, so it edits the team file
   * and waits for an explicit save — unlike the card's position, which stays in the autosaved
   * sidecar. Connecting the same capability twice is a no-op rather than a duplicate.
   */
  const setAgentCapabilities = useCallback(
    (id: string, capabilities: CapabilityRef[]) => {
      captureHistory()
      const next = capabilities.length > 0 ? capabilities : undefined
      modelRef.current?.setAgentField(id, 'capabilities', next)
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, agent: { ...node.data.agent, capabilities: next } } } : node,
        ),
      )
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const promoteEntrypoint = useCallback(
    (id: string) => {
      captureHistory()
      modelRef.current?.setEntrypoint(id)
      if (edges.length === 0 && documentSnapshot?.responder) modelRef.current?.setResponder(id)
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, isEntrypoint: node.id === id } })))
      setEntrypointState(id)
      setRefusal(null)
      markDirty()
    },
    [edges.length, documentSnapshot?.responder, markDirty, captureHistory],
  )

  const promoteResponder = useCallback(
    (id: string) => {
      captureHistory()
      modelRef.current?.setResponder(id)
      markDirty()
    },
    [markDirty, captureHistory],
  )

  // §8.1: the mode-pill popover's edit affordance for team-level `guards`/`budget` — the only
  // home these fields have, per TEAM_CONFIG.md's default-to-8 rule when a guard is absent.
  const updateTeamGuards = useCallback(
    (field: keyof GuardsConfig, value: number) => {
      captureHistory()
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
    [markDirty, captureHistory],
  )

  const updateTeamBudget = useCallback(
    (limitUsd: number) => {
      captureHistory()
      setTeamBudget((current) => {
        const next: BudgetConfig = { ...current, limitUsd }
        modelRef.current?.setTeamBudget(next)
        return next
      })
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const updateTeamSchedule = useCallback(
    (schedule: ScheduleConfig) => {
      captureHistory()
      modelRef.current?.setSchedule(schedule)
      setTeamSchedule(schedule)
      markDirty()
    },
    [markDirty, captureHistory],
  )

  // The Memory panel's half of adding a Brief entry. The Markdown file is written by
  // `PUT /api/memory/file`; the `memory.brief` line goes through the document like every other
  // executable change, so the operator reviews and saves it rather than the daemon writing YAML
  // behind their back (docs/TEAM_MEMORY.md, ADR 0014).
  const addBriefEntry = useCallback(
    (entry: BriefEntryConfig) => {
      captureHistory()
      modelRef.current?.addBriefEntry(entry)
      markDirty()
    },
    [markDirty, captureHistory],
  )

  /** Stop supplying a Brief entry. The Markdown file on disk is the operator's and is kept. */
  const removeBriefEntry = useCallback(
    (path: string) => {
      captureHistory()
      modelRef.current?.removeBriefEntry(path)
      markDirty()
    },
    [markDirty, captureHistory],
  )

  /**
   * Add or narrow one `memory.inherits` entry. Executable configuration, so it becomes an unsaved
   * change the operator reviews in the YAML preview rather than a write the daemon makes.
   */
  const addMemoryInherit = useCallback(
    (entry: { team?: string; pack?: string; appliesTo?: string[] }) => {
      captureHistory()
      try {
        modelRef.current?.addMemoryInherit(entry)
      } catch (caught: unknown) {
        setRefusal({ message: caught instanceof Error ? caught.message : String(caught) })
        return
      }
      markDirty()
    },
    [markDirty, captureHistory],
  )

  const removeMemoryInherit = useCallback(
    (key: { team?: string; pack?: string }) => {
      captureHistory()
      modelRef.current?.removeMemoryInherit(key)
      markDirty()
    },
    [markDirty, captureHistory],
  )

  /** Decline one inherited Brief entry. The origin team keeps it; this team stops being supplied it. */
  const excludeInheritedBrief = useCallback(
    (key: { team?: string; pack?: string }, path: string) => {
      captureHistory()
      try {
        modelRef.current?.excludeInheritedBrief(key, path)
      } catch (caught: unknown) {
        setRefusal({ message: caught instanceof Error ? caught.message : String(caught) })
        return
      }
      markDirty()
    },
    [markDirty, captureHistory],
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
    if (!pendingEdgeRemoval) return
    if (pendingEdgeRemoval.restoreDocument) {
      undo()
      setPendingEdgeRemoval(null)
      return
    }
    pendingEdgeRemoval.edges.forEach((edge) => modelRef.current?.addEdge(edge))
    setEdges((current) => [...current, ...pendingEdgeRemoval.edges.map(edgeFromConfig)])
    markDirty()
    setPendingEdgeRemoval(null)
  }, [markDirty, pendingEdgeRemoval, undo])

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
      captureHistory()
      modelRef.current?.addEdge(newEdge)
      setEdges((current) => [...current, edgeFromConfig(newEdge)])
      if (edges.length === 0) {
        setModeSwitchBanner(true)
      }
      markDirty()
    },
    [edges, entrypoint, markDirty, captureHistory],
  )

  // §8: a consequence of `edges`, not a setting — team when empty, pipeline otherwise.
  const mode: ExecutionMode = edges.length === 0 ? 'team' : 'pipeline'

  const pipelineSteps = useMemo<PipelineStep[]>(
    () => pipelineOrder(nodes.map((node) => node.id), edges.map((edge) => ({ from: edge.source, to: edge.target })), entrypoint),
    [nodes, edges, entrypoint],
  )

  const layoutNodes = useCallback(() => {
    if (nodes.length === 0) return
    captureHistory()
    const positions = autoLayout(
      nodes,
      edges.map((edge) => ({ from: edge.source, to: edge.target })),
    )
    setNodes((current) =>
      current.map((node) => ({ ...node, position: positions[node.id] ?? node.position })),
    )
  }, [nodes, edges, captureHistory])

  const settleNodeCollision = useCallback(
    (id: string, droppedPosition?: { x: number; y: number }) => {
      setNodes((current) => {
        const node = current.find((candidate) => candidate.id === id)
        if (!node) return current
        // React Flow supplies the authoritative final position to onNodeDragStop. Prefer it
        // over render-closure state, which can still be one drag event behind on a fast drop.
        const position = droppedPosition ?? node.position
        const next = offsetCollision(
          position,
          current.filter((candidate) => candidate.id !== id).map((candidate) => candidate.position),
        )
        if (next.x === node.position.x && next.y === node.position.y) return current
        return current.map((candidate) =>
          candidate.id === id ? { ...candidate, position: next } : candidate,
        )
      })
    },
    [],
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

  // §9.2: schema-plus-semantic-rules validation of the document as it stands right now. `null`
  // until the schema fetch above resolves — treated as "no known problems yet" everywhere below
  // rather than blocking, since client validation is a courtesy layer (§9.2), not the gate.
  const validation = useMemo<ValidationResult | null>(() => {
    if (!validator || !documentSnapshot) {
      return null
    }
    return validator(documentSnapshot)
  }, [validator, documentSnapshot])

  // §5.4: `incomplete` always shows; `error` waits for a blur or a save attempt so a field never
  // flashes red mid-keystroke, and a field still incomplete after a save attempt turns red too.
  const fieldProblemsByAgent = useMemo(
    () =>
      validation
        ? displayFieldProblems(validation.fieldProblemsByAgent, touchedFields, attemptedSave)
        : new Map(),
    [validation, touchedFields, attemptedSave],
  )

  const touchField = useCallback((agentId: string, field: AgentField) => {
    setTouchedFields((current) => {
      const key = `${agentId}:${field}`
      return current.has(key) ? current : new Set([...current, key])
    })
  }, [])

  // The node cards (§5.2) render the same reveal-gated problems as the inspector, merged into
  // `data` rather than threaded through context so the agent card stays a plain data renderer.
  const nodesForCanvas = useMemo(
    () =>
      nodes.map((node) => {
        const problems = fieldProblemsByAgent.get(node.id)
        const status = node.data.agent.status ?? 'idle'
        const ariaLabel = `${node.data.agent.name}, ${node.data.agent.role || 'no role'}, ${node.data.agent.model || 'no model'}, ${status}`
        return problems
          ? { ...node, ariaLabel, data: { ...node.data, fieldProblems: problems } }
          : { ...node, ariaLabel }
      }),
    [nodes, fieldProblemsByAgent],
  )

  const documentProblems: DocumentProblem[] = validation?.documentProblems ?? []
  // Both weights block the save (§5.4: "nothing invalid can reach disk either way").
  // Never let the brief load race bypass the client gate: wait for the daemon schema before a
  // save can start. If the fetch itself fails, the backend's 422 remains the documented
  // correctness backstop rather than pretending we validated against a bundled copy.
  const isValid = !schemaLoading && !entrypointProblem && (validation?.valid ?? true)
  const documentChipState: SaveState =
    !isValid && saveState !== 'no-file' && saveState !== 'new' && saveState !== 'read-only'
      ? 'invalid'
      : saveState

  const save = useCallback(async (): Promise<boolean> => {
    // "Settles ... on ⌘S" (§5.4): an attempted save is itself what reveals a still-incomplete
    // field as an error, whether or not the save actually proceeds below.
    setAttemptedSave(true)
    if (saveInFlightRef.current || !path || !modelRef.current || schemaLoading || readOnlyReason || entrypointProblem || (validation && !validation.valid)) {
      return false
    }
    saveInFlightRef.current = true
    setSaveState('saving')
    try {
      const loadedRevision = loadedRevisionRef.current
      const yaml = modelRef.current.toYaml()
      if (!isNewRef.current) {
        if (!loadedRevision) {
          throw new Error('Cannot verify whether the team file changed on disk.')
        }
        const disk = await fetchTeamFile(path)
        const diskRevision = disk.revision ?? await hashTeamYaml(disk.yaml)
        if (diskRevision !== loadedRevision) {
          setExternalChange({ diskYaml: disk.yaml, diskRevision })
          setSaveState('conflict')
          setSaveError(EXTERNAL_CHANGE_MESSAGE)
          return false
        }
      }

      const wasNew = isNewRef.current
      const saved = await saveTeamFile(path, yaml, wasNew ? null : loadedRevision)
      loadedRevisionRef.current = saved.revision ?? await hashTeamYaml(yaml)
      isNewRef.current = false
      setLoadedYaml(yaml)
      if (wasNew) {
        window.history.replaceState({}, '', `/?path=${encodeURIComponent(path)}`)
      }
      setSaveError(null)
      if (modelRef.current.toYaml() === yaml) {
        setSaveState('saved')
        setTimeout(() => setSaveState((current) => (current === 'saved' ? 'clean' : current)), 2000)
      } else {
        setSaveState('dirty')
      }
      return true
    } catch (error) {
      if (error instanceof TeamFileApiError && error.status === 412) {
        setSaveState('conflict')
        setSaveError(EXTERNAL_CHANGE_MESSAGE)
        try {
          const disk = await fetchTeamFile(path)
          setExternalChange({ diskYaml: disk.yaml, diskRevision: disk.revision ?? await hashTeamYaml(disk.yaml) })
        } catch (diskError) {
          if (diskError instanceof TeamFileApiError && diskError.status === 404) {
            const reason = 'File is gone. Save a copy to continue editing.'
            setExternalChange(null)
            setReadOnlyReason(reason)
            setFileGone(true)
            setSaveError(reason)
            setSaveState('read-only')
          }
        }
        return false
      }
      // §9.3: the backing file was deleted or renamed before this save reached disk. Like
      // reloadFromDisk and focus polling, keep the in-memory document, go read-only with a
      // File is gone reason, and leave Save a copy available instead of a generic error.
      if (error instanceof TeamFileApiError && error.status === 404) {
        const reason = 'File is gone. Save a copy to continue editing.'
        setReadOnlyReason(reason)
        setFileGone(true)
        setSaveError(reason)
        setSaveState('read-only')
        return false
      }
      setSaveState('error')
      setSaveError(error instanceof TeamFileApiError ? error.message : String(error))
      return false
    } finally {
      saveInFlightRef.current = false
    }
  }, [path, schemaLoading, readOnlyReason, entrypointProblem, validation])

  return {
    path,
    nodes: nodesForCanvas,
    edges,
    entrypoint,
    entrypointProblem,
    teamGuards,
    teamBudget,
    teamSchedule,
    /**
     * The team's `memory.inherits` entries as the document holds them.
     *
     * The canvas draws the **union** of the sidecar's memory cards and these, so a `memory.inherits`
     * entry written by hand in the YAML shows as a card rather than being invisible until someone
     * happens to drag the same row out of the Library.
     */
    memoryInherits: documentSnapshot?.memory?.inherits ?? [],
    responder: documentSnapshot?.responder ?? null,
    /** The team's display `name`, for chrome that should not show a file path. */
    teamName: documentSnapshot?.name?.trim() || null,
    /** True until the daemon's schema is compiled; validity is unknown, not failed, meanwhile. */
    checking: schemaLoading,
    saveState,
    documentChipState,
    saveError,
    documentProblems,
    fieldProblemsByAgent,
    isValid,
    readOnlyReason,
    fileGone,
    loadFailure,
    externalChange,
    diskNotice,
    yamlPreview,
    loadedYaml,
    canUndo: historyState.undo > 0,
    canRedo: historyState.redo > 0,
    refusal,
    mode,
    pipelineSteps,
    modeSwitchBanner,
    pendingEdgeRemoval,
    createNewDocument,
    reloadFromDisk,
    keepMine,
    useDisk,
    saveCopy,
    layoutNodes,
    applyPositions,
    settleNodeCollision,
    capturePositionHistory: captureHistory,
    undo,
    redo,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addAgentFromDrop,
    removeAgent,
    removeEdgeBetween,
    renameAgent,
    updateAgentModel,
    updateAgentSpawn,
    updateAgentThinkingEffort,
    updateAgentCwd,
    updateAgentBudget,
    updateAgentWarnAt,
    updateAgentAllowRecruiting,
    updateAgentMemory,
    setAgentCapabilities,
    promoteEntrypoint,
    promoteResponder,
    updateTeamGuards,
    updateTeamBudget,
    updateTeamSchedule,
    addBriefEntry,
    removeBriefEntry,
    addMemoryInherit,
    removeMemoryInherit,
    excludeInheritedBrief,
    touchField,
    dismissRefusal,
    keepLastEdgeRemoval,
    undoLastEdgeRemoval,
    save,
    checkDiskRevision,
    // §1.4: the revision the last load or save settled on. A function, not state: `submit()`
    // reads it immediately after awaiting `save()`, where a captured value would still be the
    // pre-save revision — and pinning the run to that is the race the field exists to close.
    currentRevision: () => loadedRevisionRef.current,
  }
}
