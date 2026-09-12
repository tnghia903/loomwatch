import { Background, getNodesBounds, getViewportForBounds, MarkerType, ReactFlow, useNodesInitialized, useReactFlow, type Edge, type EdgeChange, type Node, type NodeChange, type OnNodeDrag } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DetectedHarness } from '../lib/harnesses'
import type { AgentNode } from '../lib/library/nodeFromDrop'
import type { CapabilityInventory } from '../lib/library/client'
import { cancelRun, describeNextFire, findRunByStartKey, isTerminalRun, newStartKey, RunApiError, runScheduleNow, scheduleForPath, STALE_TEAM_REVISION, startRun, useSchedules } from '../lib/runs/client'
import { ownerLabelFor } from '../lib/runs/graph'
import type { EvidenceNode, MoreNode, OutputNode, PromptNode, RunNode, WeftEdge } from '../lib/runs/graph'
import { causalOrder, storyLayout, STORY } from '../lib/runs/storyLayout'
import { mergeHistory } from '../lib/runs/history'
import { useRunHistory } from '../lib/runs/useRunHistory'
import { useRunSession } from '../lib/runs/useRunSession'
import { fetchTeamsDiscovery } from '../lib/team-file/client'
import { reviewProblems, yamlLineForPath, type ReviewProblem } from '../lib/team-file/problems'
import { unifiedYamlDiff } from '../lib/team-file/diff'
import type { AgentConfig, AgentStatus } from '../lib/team-file/types'
import { useTeamDocument } from '../lib/team-file/useTeamDocument'
import { setThemeMode, useTheme } from '../lib/theme'
import { useAnnouncementQueue } from '../lib/useAnnouncementQueue'
import type { AgentField } from '../lib/team-file/validation'
import { formatElapsed, type Attention, type Evidence, type RunPhase, type TaskState } from '../lib/watch/events'
import { AgentNodeCard } from './canvas/AgentNodeCard'
import { CanvasActionsContext, type CanvasActions } from './canvas/CanvasActionsContext'
import { CommandPalette, type CommandAction } from './canvas/CommandPalette'
import { ConflictBar } from './canvas/ConflictBar'
import { DocumentSwitcher } from './canvas/DocumentSwitcher'
import { EdgeRefusalPopover } from './canvas/EdgeRefusalPopover'
import { EntrypointProblemBar } from './canvas/EntrypointProblemBar'
import { FirstRun } from './canvas/FirstRun'
import { Inspector } from './canvas/Inspector'
import { LayerLegend, type LayerSolo } from './canvas/LayerLegend'
import { ParseFailureModal } from './canvas/ParseFailureModal'
import { ScheduleNodeCard, type ScheduleNode } from './canvas/ScheduleNodeCard'
import { ViewControls } from './canvas/ViewControls'
import { YamlSheet } from './canvas/YamlSheet'
import { ProvEdgeView, WarpEdgeView, WeftEdgeView } from './canvas/edges'
import { Composer, type ComposerState } from './composer/Composer'
import { ModePopover } from './composer/ModePopover'
import { RunHistory } from './composer/RunHistory'
import { EVIDENCE_DRAG_MIME, Library, LIBRARY_DRAG_MIME } from './library'
import { ActivityPanel } from './run/ActivityPanel'
import { LifecycleStrip } from './run/LifecycleStrip'
import { ProvenancePanel } from './run/ProvenancePanel'
import { RunColumn } from './run/RunColumn'
import { EvidenceNodeCard, MoreEvidenceCard, OutputNodeCard, PromptNodeCard, RunNodeCard } from './run/StoryNodes'
import { ChipDot } from './ui/glyphs'

const nodeTypes = { agent: AgentNodeCard, schedule: ScheduleNodeCard, prompt: PromptNodeCard, run: RunNodeCard, evidence: EvidenceNodeCard, more: MoreEvidenceCard, output: OutputNodeCard }
const edgeTypes = { warp: WarpEdgeView, weft: WeftEdgeView, prov: ProvEdgeView }
const WARP_MARKER = { type: MarkerType.ArrowClosed, color: 'var(--color-warp)', width: 14, height: 14 }
const WEFT_MARKER = { type: MarkerType.Arrow, color: 'var(--color-accent)', width: 16, height: 16 }
const PROV_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 14, height: 14 }
const LIVE_MARKER = { type: MarkerType.Arrow, color: 'var(--color-live)', width: 14, height: 14 }
const EMPTY_CAPABILITY_INVENTORY: CapabilityInventory = { skills: [], tools: [], sources: [] }

interface WorkspaceProps {
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  harnessesError: string | null
  onRetryHarnesses: () => void
  capabilityInventory?: CapabilityInventory
  capabilitiesLoading?: boolean
  capabilitiesError?: string | null
  capabilitiesScannedAt?: Date | null
  onRetryCapabilities?: () => void
  onDocumentOpen: () => void
  initialRunId: string | null
  initialHistoryOpen?: boolean
}

type AnyNode = Node
type AnyEdge = Edge

function linesDiffer(a: string, b: string): number {
  if (a === b) return 0
  const left = a.split('\n')
  const right = b.split('\n')
  const rightSet = new Map<string, number>()
  right.forEach((line) => rightSet.set(line, (rightSet.get(line) ?? 0) + 1))
  let onlyLeft = 0
  const leftSet = new Map<string, number>()
  left.forEach((line) => leftSet.set(line, (leftSet.get(line) ?? 0) + 1))
  for (const [line, count] of leftSet) onlyLeft += Math.max(0, count - (rightSet.get(line) ?? 0))
  let onlyRight = 0
  for (const [line, count] of rightSet) onlyRight += Math.max(0, count - (leftSet.get(line) ?? 0))
  return Math.max(onlyLeft, onlyRight, 1)
}

function syntheticAgent(id: string): AgentConfig {
  return { id, name: id, role: 'Observed agent', spawn: { cmd: '', args: [], env: {}, cwd: '.' }, model: '', budget: { limitUsd: 0 } }
}

function writeRunToUrl(runId: string | null) {
  const params = new URLSearchParams(window.location.search)
  if (runId) params.set('run', runId)
  else params.delete('run')
  const query = params.toString()
  window.history.replaceState({}, '', query ? `/?${query}` : '/')
}

export function Workspace({ harnesses, harnessesLoading, harnessesError, onRetryHarnesses, capabilityInventory = EMPTY_CAPABILITY_INVENTORY, capabilitiesLoading = false, capabilitiesError = null, capabilitiesScannedAt = null, onRetryCapabilities = () => {}, onDocumentOpen, initialRunId, initialHistoryOpen = false }: WorkspaceProps) {
  const doc = useTeamDocument()
  const flow = useReactFlow()
  const { resolved: theme } = useTheme()
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const editable = !doc.readOnlyReason && windowWidth >= 768

  // ---- chrome state --------------------------------------------------------------------
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [openPathOpen, setOpenPathOpen] = useState(false)
  const [newTeamSheet, setNewTeamSheet] = useState(false)
  const [saveCopyOpen, setSaveCopyOpen] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [pendingNodeDelete, setPendingNodeDelete] = useState<string[]>([])
  const [libraryDragging, setLibraryDragging] = useState(false)
  const [nodeDragging, setNodeDragging] = useState(false)
  const nodeDraggingRef = useRef(false)
  const [runNodeMeasurements, setRunNodeMeasurements] = useState<Record<string, { width: number; height: number }>>({})
  const [libraryCollapsed, setLibraryCollapsed] = useState(true)
  const [solo, setSolo] = useState<LayerSolo>('both')
  const [sweeping, setSweeping] = useState(false)
  const [notificationsOn, setNotificationsOn] = useState(false)
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
  const [problemCursor, setProblemCursor] = useState(-1)
  const problemFieldRef = useRef<{ agentId: string; field: AgentField } | null>(null)
  const [problemFocusRequest, setProblemFocusRequest] = useState(0)
  const [yamlHighlightLine, setYamlHighlightLine] = useState<number | null>(null)
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false)

  // ---- run state -----------------------------------------------------------------------
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId)
  const [composerText, setComposerText] = useState('')
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // §1.6: the start key of the attempt in hand, surviving a failed POST so the re-press is the
  // same attempt. Cleared once the daemon answers with a run id.
  const startAttempt = useRef<{ identity: string; key: string } | null>(null)
  const [runPositions, setRunPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [inspectedEvidenceId, setInspectedEvidenceId] = useState<string | null>(null)
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  const [retryOf] = useState<Map<string, string>>(() => new Map())
  const history = useRunHistory(historyOpen)
  const schedules = useSchedules()
  const [routineBusy, setRoutineBusy] = useState(false)
  const responderFromDoc = doc.mode === 'pipeline' ? doc.pipelineSteps[doc.pipelineSteps.length - 1]?.id ?? doc.entrypoint : doc.entrypoint
  const session = useRunSession(activeRunId, responderFromDoc)
  const record = session.record
  const projection = session.projection
  const runView = activeRunId !== null
  const routine = useMemo(() => scheduleForPath(schedules.entries, doc.path), [schedules.entries, doc.path])
  // The registry knows the canonical responder for its own runs; history falls back to the document.
  const responderId = record?.responder ?? responderFromDoc

  /** Every route into or out of a run passes through here so per-run view state resets together. */
  const showRun = useCallback((runId: string | null) => {
    setActiveRunId(runId)
    writeRunToUrl(runId)
    setRunPositions({})
    setInspectedEvidenceId(null)
    setProvenanceOpen(false)
    setDismissedAlerts(new Set())
    // Solo is per-run view state too: a layer soloed in one story must not bleed into the next.
    setSolo('both')
  }, [])
  // The library is composition chrome; once a run is on screen it yields (the prototype's run
  // screens open with the rail). Keyed on the path too: before the document loads there is
  // no Library mounted to hear the event.
  useEffect(() => {
    if (activeRunId && doc.path) window.dispatchEvent(new Event('loomwatch:close-library'))
  }, [activeRunId, doc.path])

  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // ---- starting a run: there is no "run without saving" (TNG89 §1.4) ------------------
  const launch = useCallback(async (prompt: string, parent?: string | null, expectedRevision: string | null = null) => {
    if (!doc.path) return
    // §1.6: one start key per attempt, held for the life of the attempt. An attempt is this
    // prompt against this revision of this file, so a re-press after a lost response carries the
    // SAME key and the daemon answers with the run it already started (200) instead of starting a
    // second one. A connection loss during submit never retries blind.
    const identity = `${doc.path}\0${expectedRevision ?? ''}\0${prompt}`
    const attempt = startAttempt.current?.identity === identity ? startAttempt.current : { identity, key: newStartKey() }
    startAttempt.current = attempt
    setStarting(true)
    setStartError(null)
    try {
      const created = await startRun(doc.path, prompt, { startKey: attempt.key, expectedRevision })
      startAttempt.current = null
      if (parent) retryOf.set(created.runId, parent)
      session.applyRecord(created)
      showRun(created.runId)
      setComposerText('')
      window.dispatchEvent(new Event('loomwatch:close-library'))
      void history.refresh()
    } catch (caught) {
      // §1.6: a lost response is not a failed run, it is an unknown one — so ask the daemon what
      // this start key did before reporting anything. A `RunApiError` is an answer and needs no
      // recovery; anything else means none arrived, and a 404 here is the daemon saying the
      // request never landed. Guessing either way is the blind retry the clause forbids.
      const recovered = caught instanceof RunApiError ? null : await findRunByStartKey(attempt.key).catch(() => null)
      if (recovered) {
        startAttempt.current = null
        if (parent) retryOf.set(recovered.runId, parent)
        session.applyRecord(recovered)
        showRun(recovered.runId)
        setComposerText('')
        window.dispatchEvent(new Event('loomwatch:close-library'))
        void history.refresh()
        return
      }
      // §1.5: the file moved between the save and the start, so no run was created. Hand it to
      // the §9.3 conflict bar rather than reporting it as a failed start; the prompt stays put.
      if (caught instanceof RunApiError && caught.code === STALE_TEAM_REVISION) void doc.checkDiskRevision()
      setStartError(caught instanceof RunApiError ? caught.message : String(caught))
    } finally {
      setStarting(false)
    }
  }, [doc, history, retryOf, session, showRun])

  const submit = useCallback(async (promptOverride?: string) => {
    const prompt = (promptOverride ?? composerText).trim()
    if (!prompt || !doc.path) return
    // §1.6: re-pressing while a start is in flight is a no-op, not a second run.
    if (starting || pendingPrompt !== null) return
    const parent = activeRunId && isTerminalRun(record?.status) ? activeRunId : null
    // §1.4: there is no "run without saving" — the run executes an exact snapshot of the file.
    if (['dirty', 'new'].includes(doc.documentChipState)) {
      setPendingPrompt(prompt)
      const saved = await doc.save()
      setPendingPrompt(null)
      if (!saved) { setStartError('The team file could not be saved, so no run was started.'); return }
    }
    // §1.4: the run is pinned to `expectedRevision` — the revision the PUT just returned, read
    // after the await so it is the one this save landed and not the one loaded before it.
    await launch(prompt, parent, doc.currentRevision())
  }, [composerText, doc, launch, activeRunId, record?.status, starting, pendingPrompt])

  const stop = useCallback(async () => {
    if (!activeRunId) return
    try { session.applyRecord(await cancelRun(activeRunId)) } catch (caught) { setStartError(caught instanceof Error ? caught.message : String(caught)) }
  }, [activeRunId, session])

  const retry = useCallback(() => {
    const prompt = record?.prompt ?? projection.prompt ?? ''
    if (prompt) void submit(prompt)
  }, [projection.prompt, record?.prompt, submit])

  // §3.4: `[ Reuse ]` on the failed response node copies the run's original prompt back
  // into the composer — the prompt survives on the Prompt node (§12.2), so this is a
  // missing route, not lost data.
  const reusePrompt = useCallback(() => {
    const prompt = record?.prompt ?? projection.prompt ?? ''
    if (!prompt) return
    setComposerText(prompt)
    document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus()
  }, [record?.prompt, projection.prompt])

  const closeRun = useCallback(() => showRun(null), [showRun])

  const runRoutineNow = useCallback(async () => {
    if (!routine || routineBusy) return
    setRoutineBusy(true)
    setStartError(null)
    try {
      const created = await runScheduleNow(routine.teamPath)
      session.applyRecord(created)
      showRun(created.runId)
      setModeOpen(false)
      schedules.refresh()
      void history.refresh()
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRoutineBusy(false)
    }
  }, [routine, routineBusy, session, showRun, schedules, history])

  // ---- team graph ----------------------------------------------------------------------
  const stepById = useMemo(() => new Map(doc.pipelineSteps.map((step) => [step.id, { ...step, step: step.step + (doc.teamSchedule ? 1 : 0) }])), [doc.pipelineSteps, doc.teamSchedule])
  const nodeNames = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node.data.label])), [doc.nodes])
  const problems = useMemo(() => reviewProblems(doc.entrypointProblem, doc.fieldProblemsByAgent, doc.documentProblems, nodeNames), [doc.entrypointProblem, doc.fieldProblemsByAgent, doc.documentProblems, nodeNames])
  const scheduleProblems = useMemo(() => problems.filter((problem) => problem.yamlPath?.[0] === 'schedule'), [problems])
  const visibleSchedule = useMemo(() => doc.teamSchedule ?? (scheduleProblems.length > 0 ? { cron: '0 8 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: 'Run this team on schedule.', enabled: true } : null), [doc.teamSchedule, scheduleProblems.length])
  const saveSchedule = useCallback((schedule: NonNullable<typeof visibleSchedule>) => {
    doc.updateTeamSchedule(schedule)
    setScheduleEditorOpen(false)
    setStatusAnnouncement('Schedule updated. Save the team to finish.')
  }, [doc])
  const showScheduleYaml = useCallback(() => {
    setScheduleEditorOpen(false)
    setYamlHighlightLine(yamlLineForPath(doc.yamlPreview, ['schedule']))
    setYamlOpen(true)
  }, [doc.yamlPreview])
  const configuredPairs = useMemo(() => new Set(doc.edges.map((edge) => `${edge.source}->${edge.target}`)), [doc.edges])

  const anomalies = useMemo(() => (doc.mode === 'pipeline' ? projection.delegations.filter((delegation) => !configuredPairs.has(`${delegation.from}->${delegation.to}`)) : []), [doc.mode, projection.delegations, configuredPairs])

  const leadId = record?.entrypoint ?? doc.entrypoint ?? projection.promptAgentId
  const agentOrder = useMemo(() => (runView ? causalOrder(doc.pipelineSteps.map((step) => step.id), projection.agents, leadId) : []), [runView, doc.pipelineSteps, projection.agents, leadId])
  const orderedAgentIds = useMemo(() => {
    if (!runView) return []
    const ids = [...agentOrder]
    doc.nodes.forEach((node) => { if (!ids.includes(node.id)) ids.push(node.id) })
    return ids
  }, [runView, agentOrder, doc.nodes])
  const ownerLabels = useMemo(() => new Map(orderedAgentIds.map((id, index) => [id, ownerLabelFor(index, orderedAgentIds.length, id, nodeNames)])), [orderedAgentIds, nodeNames])
  const evidenceByAgent = useMemo(() => {
    const map = new Map<string, string[]>()
    projection.evidence.forEach((item) => { const list = map.get(item.agentId) ?? []; list.push(item.id); map.set(item.agentId, list) })
    return map
  }, [projection.evidence])
  const layout = useMemo(() => storyLayout({ agentIds: orderedAgentIds, evidenceByAgent, overrides: runPositions }), [orderedAgentIds, evidenceByAgent, runPositions])

  // CONTRACT §4: only the canonical responder's reply is the answer; other agents' messages
  // are evidence. The fallback exists solely for archived sessions whose team is unknown.
  const responderAgent = projection.agents.find((agent) => agent.id === responderId) ?? (responderId ? undefined : [...projection.agents].reverse().find((agent) => agent.reply))
  const responseText = responderAgent?.reply ?? ''
  const phase: RunPhase = projection.phase
  const live = session.mode === 'live'
  const attempt = useMemo(() => {
    if (!activeRunId) return 1
    const all = mergeHistory(history.records, history.sessions).map((entry) => entry.id).reverse()
    const index = all.indexOf(activeRunId)
    return index >= 0 ? index + 1 : all.length + 1
  }, [activeRunId, history.records, history.sessions])
  const elapsed = formatElapsed(projection.startedAt ?? record?.startedAt ?? record?.createdAt ?? null, isTerminalRun(record?.status) || !live ? projection.updatedAt ?? record?.finishedAt ?? null : new Date().toISOString())

  const graph = useMemo(() => {
    if (!runView) {
      const nodes: AnyNode[] = doc.nodes.map((node) => ({ ...node, ariaLabel: `${node.data.agent.name}, ${node.data.agent.role || 'no role'}, ${node.data.agent.model || 'no model'}, ${node.data.agent.status ?? 'idle'}`, ariaRole: 'button' as const }))
      const edges: AnyEdge[] = doc.edges.map((edge) => ({ ...edge, type: 'warp', markerEnd: WARP_MARKER, ariaLabel: `sequence from ${nodeNames.get(edge.source) ?? edge.source} to ${nodeNames.get(edge.target) ?? edge.target}` }))
      if (visibleSchedule) {
        const first = doc.nodes.find((node) => node.id === doc.entrypoint) ?? doc.nodes[0]
        const scheduleNode: ScheduleNode = {
          id: '__schedule',
          type: 'schedule',
          position: { x: (first?.position.x ?? 0) - 340, y: first?.position.y ?? 0 },
          draggable: false,
          selectable: true,
          selected: scheduleEditorOpen,
          connectable: false,
          data: {
            schedule: visibleSchedule,
            invalid: scheduleProblems.length > 0,
            editorOpen: scheduleEditorOpen,
            readOnly: !editable,
            onOpen: () => setScheduleEditorOpen(true),
            onClose: () => setScheduleEditorOpen(false),
            onSave: saveSchedule,
            onAdvanced: showScheduleYaml,
          },
        }
        nodes.unshift(scheduleNode)
        if (first) edges.unshift({ id: '__schedule->entrypoint', source: '__schedule', target: first.id, type: 'warp', markerEnd: WARP_MARKER, selectable: false, focusable: false, ariaLabel: `schedule starts ${first.data.label}` })
      }
      return { nodes, edges }
    }
    const nodes: AnyNode[] = []
    const edges: AnyEdge[] = []
    const addNode = (node: AnyNode) => {
      const measured = runNodeMeasurements[node.id]
      nodes.push(measured ? { ...node, measured } : node)
    }
    const promptText = record?.prompt ?? projection.prompt ?? ''
    const runId = activeRunId ?? ''
    const prompt: PromptNode = { id: '__prompt', type: 'prompt', position: runPositions.__prompt ?? layout.prompt, data: { text: promptText || '(prompt not archived)', attempt, runId }, draggable: true, selectable: false, connectable: false }
    const parent = retryOf.get(runId)
    const run: RunNode = { id: '__run', type: 'run', position: runPositions.__run ?? layout.run, data: { attempt, phase, runId, mode: session.mode, branch: parent ? `Retry of an earlier run` : 'Initiating branch', elapsed, trigger: record?.trigger }, draggable: true, selectable: false, connectable: false }
    addNode(prompt)
    addNode(run)
    edges.push({ id: '__prompt->__run', source: '__prompt', target: '__run', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'starts', story: true }, selectable: false, focusable: false })

    const projectedById = new Map(projection.agents.map((agent) => [agent.id, agent]))
    orderedAgentIds.forEach((id) => {
      const docNode = doc.nodes.find((node) => node.id === id)
      const projected = projectedById.get(id)
      const agent = docNode?.data.agent ?? syntheticAgent(id)
      const label = ownerLabels.get(id) ?? id
      const costUsd = projected?.costUsd ?? null
      const runtime = projected
        ? { status: projected.status, taskState: projected.taskState, task: projected.task, ownerLabel: label, costUsd, spentPct: costUsd !== null && agent.budget.limitUsd > 0 ? (costUsd / agent.budget.limitUsd) * 100 : null, live: live && (projected.status === 'running' || projected.status === 'starting'), busUnavailable: projected.busUnavailable }
        : { status: 'idle' as AgentStatus, taskState: (phase === 'queued' || phase === 'starting' ? 'QUEUED' : 'READY') as TaskState, task: phase === 'queued' || phase === 'starting' ? 'Waiting for the run to start' : 'Awaiting a task', ownerLabel: label, costUsd: null, spentPct: null, live: false }
      const node: AgentNode = {
        id, type: 'agent', position: layout.agents[id], draggable: true, connectable: false,
        selected: docNode?.selected ?? false,
        data: { label: agent.name, agent, isEntrypoint: id === leadId, fieldProblems: docNode?.data.fieldProblems, runtime },
      }
      addNode({ ...node, ariaLabel: `${agent.name}, ${label}, ${runtime.taskState}, ${runtime.task}`, ariaRole: 'button' as const })
    })
    if (leadId && layout.agents[leadId]) edges.push({ id: '__run->lead', source: '__run', sourceHandle: 'lead', target: leadId, type: 'prov', markerEnd: PROV_MARKER, data: { label: 'assigns lead', story: true }, selectable: false, focusable: false })

    const delegationCounts = new Map<string, number>()
    projection.delegations.forEach((delegation) => { const key = `${delegation.from}->${delegation.to}`; delegationCounts.set(key, (delegationCounts.get(key) ?? 0) + 1) })
    doc.edges.forEach((edge) => {
      const key = `${edge.source}->${edge.target}`
      const count = delegationCounts.get(key) ?? 0
      edges.push({ ...edge, type: 'warp', markerEnd: WARP_MARKER, data: { ...edge.data!, count: count || undefined, shuttle: count > 0 && live && projectedById.get(edge.target)?.status === 'running' }, selectable: false, focusable: false, ariaLabel: `sequence from ${nodeNames.get(edge.source) ?? edge.source} to ${nodeNames.get(edge.target) ?? edge.target}` })
    })
    const seenWeft = new Set<string>()
    projection.delegations.forEach((delegation) => {
      const key = `${delegation.from}->${delegation.to}`
      if (configuredPairs.has(key) || seenWeft.has(`${key}:${delegation.kind}`)) return
      seenWeft.add(`${key}:${delegation.kind}`)
      // DESIGN_LANGUAGE §13: the weft fades once its target is no longer live, so the
      // live frontier of the graph is the brightest thing on screen.
      const targetStatus = projectedById.get(delegation.to)?.status
      const aged = !(live && (targetStatus === 'running' || targetStatus === 'starting' || targetStatus === 'waiting'))
      const weft: WeftEdge = { id: `weft:${key}:${delegation.kind}`, source: delegation.from, target: delegation.to, type: 'weft', markerEnd: WEFT_MARKER, markerStart: delegation.kind === 'ask' ? WEFT_MARKER : undefined, data: { kind: delegation.kind, count: delegationCounts.get(key), anomaly: doc.mode === 'pipeline', aged }, selectable: false, focusable: false }
      edges.push(weft)
    })

    Object.entries(layout.more).forEach(([agentId, slot]) => {
      const moreNode: MoreNode = { id: `__more:${agentId}`, type: 'more', position: runPositions[`__more:${agentId}`] ?? { x: slot.x, y: slot.y }, draggable: true, selectable: false, connectable: false, data: { agentId, ownerLabel: ownerLabels.get(agentId) ?? agentId, hidden: slot.hidden, total: evidenceByAgent.get(agentId)?.length ?? slot.hidden } }
      addNode(moreNode)
      edges.push({ id: `more:${agentId}`, source: agentId, target: moreNode.id, type: 'prov', markerEnd: PROV_MARKER, data: {}, selectable: false, focusable: false })
    })
    projection.evidence.forEach((item) => {
      // Evidence folded into the "+N more" card has no slot and no node; the panel lists it.
      const position = runPositions[item.id] ?? layout.evidence[item.id]
      if (!position) return
      const evidenceNode: EvidenceNode = { id: item.id, type: 'evidence', position, draggable: true, connectable: false, data: { evidence: item, ownerLabel: ownerLabels.get(item.agentId) ?? item.agentId, live: live && (item.status === 'running' || item.status === 'pending'), selected: inspectedEvidenceId === item.id } }
      addNode(evidenceNode)
      const isLive = live && (item.status === 'running' || item.status === 'pending')
      edges.push({ id: `ev:${item.id}`, source: item.agentId, target: item.id, type: 'prov', markerEnd: isLive ? LIVE_MARKER : PROV_MARKER, data: { live: isLive }, selectable: false, focusable: false, ariaLabel: `${ownerLabels.get(item.agentId) ?? item.agentId} ${item.relation} ${item.name}` })
    })

    const responderLabel = responderAgent ? ownerLabels.get(responderAgent.id) ?? responderAgent.id : responderId ? ownerLabels.get(responderId) ?? responderId : 'the responder'
    const streaming = live && phase === 'running' && responderAgent?.taskState === 'STREAMING'
    const pending = phase === 'queued' || phase === 'starting'
    const runningCount = projection.agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length
    const phaseText = phase === 'queued' ? 'Queued — waiting for a supervisor.'
      : phase === 'starting' ? `Starting ${nodeNames.get(leadId ?? '') ?? leadId ?? 'the lead'}…`
      : phase === 'running' ? (streaming ? `Streaming — ${responderLabel.split(' · ')[0]} responding.` : `Running — ${runningCount} agent${runningCount === 1 ? '' : 's'} active.`)
      : phase === 'succeeded' ? `Answered in ${elapsed}.`
      : phase === 'partial' ? 'Partial answer.'
      : phase === 'failed' ? 'Run failed.'
      : 'Cancelled — partial answer kept.'
    const crash = projection.attention.find((alert) => /crash/i.test(alert.message))
    // §3.4 / CONTRACT §3: the strip carries the daemon's stable machine-readable code and
    // its verbatim message — never a token or a sentence manufactured here. The watermark
    // resolves the daemon's own code, then its stop reason, then the one code the contract
    // itself assigns to an evidence-derived condition (`missing_canonical_response`,
    // CONTRACT §4, via the projection), then the exit fact; when the daemon reported none
    // of these it says so instead of picking a plausible token.
    const exitFact = record?.exitCode !== null && record?.exitCode !== undefined ? `exit ${record.exitCode}` : null
    const strip = session.error && live ? { tone: 'halt' as const, message: `Live events reconnecting — answer shown to`, watermark: `seq ${session.lastSeq}` }
      : phase === 'partial' || phase === 'failed' ? {
          tone: 'alert' as const,
          message: record?.error ?? crash?.message
            ?? (phase === 'failed' && (record?.errorCode ?? record?.stopReason ?? projection.errorCode) === 'missing_canonical_response'
              ? 'The run finished but no agent produced an answer.'
              : 'No error message was reported.'),
          watermark: record?.errorCode ?? record?.stopReason ?? projection.errorCode ?? exitFact ?? 'no code reported',
        }
      : phase === 'cancelled' ? { tone: 'halt' as const, message: 'Cancelled by the operator. Partial answer kept.', watermark: 'cancelled' }
      : null
    const output: OutputNode = { id: '__output', type: 'output', position: runPositions.__output ?? layout.output, draggable: true, selectable: false, connectable: false, data: { text: responseText, phase, phaseText, producer: responderAgent?.id ?? responderId ?? null, producerLabel: responderLabel, mode: session.mode, streaming, pending, strip, compact: provenanceOpen, expanded: provenanceOpen, terminal: session.terminal } }
    addNode(output)
    const producer = responderAgent?.id ?? responderId
    if (producer && layout.agents[producer]) edges.push({ id: '__responds', source: producer, target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'responds with', story: true }, selectable: false, focusable: false })
    edges.push({ id: '__completes', source: '__run', target: '__output', targetHandle: 'run', type: 'prov', markerEnd: PROV_MARKER, data: { label: `Run ${String(attempt).padStart(2, '0')} · completes as`, story: true, arc: true }, selectable: false, focusable: false })
    return { nodes, edges }
  }, [runView, doc.nodes, doc.edges, doc.mode, doc.entrypoint, nodeNames, projection, record, activeRunId, layout, attempt, retryOf, phase, session.mode, session.error, session.lastSeq, session.terminal, elapsed, orderedAgentIds, ownerLabels, evidenceByAgent, leadId, live, configuredPairs, runPositions, runNodeMeasurements, inspectedEvidenceId, responderAgent, responderId, responseText, provenanceOpen, visibleSchedule, scheduleProblems.length, scheduleEditorOpen, editable, saveSchedule, showScheduleYaml])

  const observedCount = projection.delegations.length
  // UX_REDESIGN §6.7: solo is conditional chrome — the legend is its only readout and click-path
  // back, so the cycle control may act only while the legend is on screen. Observed (weft) edges
  // are a run-view projection, so the predicate is run-view only; a solo left over from a run
  // (e.g. a replay scrubbed past the delegations) suspends instead of silently blanking edges.
  const layersVisible = runView && observedCount > 0
  const soloActive: LayerSolo = layersVisible ? solo : 'both'
  const visibleEdges = useMemo(() => graph.edges.filter((edge) => soloActive === 'both' || (soloActive === 'configured' ? edge.type !== 'weft' : edge.type !== 'warp')), [graph.edges, soloActive])

  // ---- fit the view whenever the story changes shape -----------------------------------
  // Refit as the live story grows (new agents, evidence rows, the answer, the terminal
  // state) but never while scrubbing a replay — the cursor must not move the camera.
  const fitKey = runView ? `${activeRunId}:${orderedAgentIds.join('|')}:${session.latest.evidence.length}:${session.latest.agents.some((agent) => agent.reply) ? 'o' : ''}:${session.terminal ? 't' : ''}` : `compose:${doc.nodes.length}:${visibleSchedule ? 'scheduled' : 'manual'}`
  const nodesInitialized = useNodesInitialized()
  const canvasRef = useRef<HTMLDivElement>(null)
  const pendingFit = useRef<string | null>(null)
  const lastFit = useRef('')
  // A Library toggle reframes too: the panel hides part of the canvas, so what "fits" changes.
  useEffect(() => {
    lastFit.current = fitKey
    pendingFit.current = fitKey
  }, [fitKey, libraryCollapsed])
  useEffect(() => {
    // React Flow can only frame nodes it has measured; a fit requested while new cards are
    // still mounting waits for `useNodesInitialized` to flip back to true.
    if (!pendingFit.current || !nodesInitialized || nodeDragging) return
    pendingFit.current = null
    // Frame the story in the area the Library (or its rail) leaves visible, not the whole
    // canvas: computed directly from the measured bounds so nothing races React Flow's own
    // asynchronous fitView, and applied without animation in a hidden tab.
    const covered = windowWidth < 768 ? 0 : libraryCollapsed ? 48 + 20 : 288 + 56
    const fit = () => {
      if (nodeDraggingRef.current) return
      const canvas = canvasRef.current
      const nodes = flow.getNodes()
      if (!canvas || nodes.length === 0) return
      const bounds = getNodesBounds(nodes)
      const viewport = getViewportForBounds(bounds, Math.max(200, canvas.clientWidth - covered), canvas.clientHeight, 0.25, 1, 0.22)
      void flow.setViewport({ ...viewport, x: viewport.x + covered }, { duration: document.hidden ? 0 : 320 })
    }
    // Timers rather than requestAnimationFrame: a run often finishes while the tab is in the
    // background, where animation frames are paused and the fit would never happen. Cards
    // that grow after mounting (streamed text, wrapped titles) shift the bounds once more, so
    // a settle pass keeps the whole story in frame without following every keystroke.
    const first = window.setTimeout(fit, 0)
    const settle = window.setTimeout(fit, 450)
    return () => { window.clearTimeout(first); window.clearTimeout(settle) }
  }, [fitKey, nodesInitialized, flow, windowWidth, libraryCollapsed, nodeDragging])

  // ---- selection + changes -------------------------------------------------------------
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    if (!runView) {
      if (changes.some((change) => change.type === 'select' && change.id === '__schedule' && change.selected)) setScheduleEditorOpen(true)
      doc.onNodesChange(changes.filter((change) => !('id' in change) || change.id !== '__schedule') as NodeChange<AgentNode>[])
      return
    }
    const agentChanges = changes.filter((change) => 'id' in change && doc.nodes.some((node) => node.id === change.id) && change.type === 'select')
    if (agentChanges.length > 0) doc.onNodesChange(agentChanges as NodeChange<AgentNode>[])
    const dimensions = changes.filter((change) => change.type === 'dimensions' && change.dimensions)
    if (dimensions.length > 0) setRunNodeMeasurements((current) => {
      let next = current
      for (const change of dimensions) {
        if (change.type !== 'dimensions' || !change.dimensions) continue
        const prior = current[change.id]
        if (prior?.width === change.dimensions.width && prior.height === change.dimensions.height) continue
        if (next === current) next = { ...current }
        next[change.id] = change.dimensions
      }
      return next
    })
    const positions = changes.filter((change) => change.type === 'position' && change.position)
    if (positions.length > 0) setRunPositions((current) => {
      let next = current
      for (const change of positions) {
        if (change.type !== 'position' || !change.position) continue
        const prior = current[change.id]
        if (prior?.x === change.position.x && prior.y === change.position.y) continue
        if (next === current) next = { ...current }
        next[change.id] = change.position
      }
      return next
    })
    for (const change of changes) {
      if (change.type === 'select' && change.selected && !doc.nodes.some((node) => node.id === change.id) && projection.evidence.some((item) => item.id === change.id)) setInspectedEvidenceId(change.id)
    }
  }, [runView, doc, projection.evidence])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!runView) doc.onEdgesChange(changes as EdgeChange<never>[])
  }, [runView, doc])

  const clearSelection = useCallback(() => {
    doc.onNodesChange(doc.nodes.filter((node) => node.selected).map((node) => ({ id: node.id, type: 'select' as const, selected: false })))
    doc.onEdgesChange(doc.edges.filter((edge) => edge.selected).map((edge) => ({ id: edge.id, type: 'select' as const, selected: false })))
    setInspectedEvidenceId(null)
  }, [doc])

  const selectedNodes = doc.nodes.filter((node) => node.selected)
  const selectedEdges = doc.edges.filter((edge) => edge.selected)
  const selectedDocNode = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : null
  const inspectedNode = selectedDocNode
    ? ((runView ? graph.nodes.find((node) => node.id === selectedDocNode.id && node.type === 'agent') : undefined) as AgentNode | undefined) ?? selectedDocNode
    : null
  const inspectedEvidence: Evidence | null = inspectedEvidenceId ? projection.evidence.find((item) => item.id === inspectedEvidenceId) ?? null : null
  const inspecting = Boolean(inspectedNode || inspectedEvidence || provenanceOpen)

  const deleteNodes = useCallback((ids: readonly string[]) => { if (ids.length > 0) doc.onNodesChange(ids.map((id) => ({ id, type: 'remove' as const }))) }, [doc])
  const requestNodeDelete = useCallback((ids: readonly string[]) => {
    if (!editable || ids.length === 0 || runView) return
    if (doc.edges.some((edge) => ids.includes(edge.source) || ids.includes(edge.target))) { setPendingNodeDelete([...ids]); return }
    deleteNodes(ids)
  }, [doc.edges, editable, deleteNodes, runView])

  const selectProblem = useCallback((problem: ReviewProblem) => {
    if (runView) showRun(null)
    if (problem.yamlPath?.[0] === 'schedule') {
      setScheduleEditorOpen(true)
      const scheduleNode = flow.getNode('__schedule')
      if (scheduleNode) void flow.fitView({ nodes: [scheduleNode], padding: 0.7, maxZoom: 1, duration: 300 })
      return
    }
    const problemEdge = problem.edge ? doc.edges.find((edge) => edge.source === problem.edge?.from && edge.target === problem.edge?.to) : undefined
    const targetIds = problem.agentId ? [problem.agentId] : problem.edge ? [problem.edge.from, problem.edge.to] : []
    doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: targetIds.includes(node.id) })))
    doc.onEdgesChange(doc.edges.map((edge) => ({ id: edge.id, type: 'select' as const, selected: edge.id === problemEdge?.id })))
    const targets = doc.nodes.filter((node) => targetIds.includes(node.id))
    if (targets.length > 0 && (problem.field || problemEdge)) {
      void flow.fitView({ nodes: targets, padding: 0.35, maxZoom: 1, duration: 300 })
      problemFieldRef.current = problem.agentId && problem.field ? { agentId: problem.agentId, field: problem.field } : null
      if (problemFieldRef.current) setProblemFocusRequest((request) => request + 1)
      return
    }
    if (!problem.yamlPath && targets.length > 0) {
      void flow.fitView({ nodes: targets, padding: 0.35, maxZoom: 1, duration: 300 })
      return
    }
    setYamlHighlightLine(yamlLineForPath(doc.yamlPreview, problem.yamlPath))
    setYamlOpen(true)
  }, [doc, flow, runView, showRun])
  useEffect(() => {
    const problemField = problemFieldRef.current
    if (!problemField || inspectedNode?.id !== problemField.agentId) return
    const control = document.querySelector<HTMLElement>(`[data-agent-field="${problemField.field}"]`)
    control?.scrollIntoView?.({ block: 'center' })
    control?.focus({ preventScroll: true })
    problemFieldRef.current = null
  }, [problemFocusRequest, inspectedNode?.id])
  const cycleProblem = useCallback((direction: 1 | -1) => {
    if (problems.length === 0) return
    const next = (problemCursor + direction + problems.length) % problems.length
    setProblemCursor(next)
    selectProblem(problems[next])
  }, [problems, problemCursor, selectProblem])

  // ---- drag from the library ------------------------------------------------------------
  const onDragOver = useCallback((event: React.DragEvent) => {
    const agentSource = event.dataTransfer.types.includes(LIBRARY_DRAG_MIME)
    const evidenceSource = event.dataTransfer.types.includes(EVIDENCE_DRAG_MIME)
    if ((!editable || runView || !agentSource) && (!runView || !evidenceSource)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = evidenceSource ? 'move' : 'copy'
  }, [editable, runView])
  const onDrop = useCallback((event: React.DragEvent) => {
    setLibraryDragging(false)
    if (runView) {
      const evidenceId = event.dataTransfer.getData(EVIDENCE_DRAG_MIME)
      if (!evidenceId || !projection.evidence.some((item) => item.id === evidenceId)) return
      event.preventDefault()
      setRunPositions((current) => ({ ...current, [evidenceId]: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) }))
      setInspectedEvidenceId(evidenceId)
      return
    }
    if (!editable) return
    const raw = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
    if (!raw) return
    event.preventDefault()
    doc.addAgentFromDrop(raw, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [doc, flow, editable, runView, projection.evidence])

  const onNodeDragStart = useCallback<OnNodeDrag<AnyNode>>(() => {
    nodeDraggingRef.current = true
    setNodeDragging(true)
    if (!runView) doc.capturePositionHistory()
  }, [doc, runView])
  const onNodeDragStop = useCallback<OnNodeDrag<AnyNode>>((_event, node) => {
    nodeDraggingRef.current = false
    setNodeDragging(false)
    if (!runView) doc.settleNodeCollision(node.id, node.position)
  }, [doc, runView])
  useEffect(() => {
    const add = (event: Event) => {
      if (!editable || !doc.path) return
      if (runView) showRun(null)
      doc.addAgentFromDrop((event as CustomEvent<string>).detail, flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
    }
    window.addEventListener('loomwatch:add-agent', add)
    return () => window.removeEventListener('loomwatch:add-agent', add)
  }, [doc, editable, flow, runView, showRun])

  // ---- notifications + announcements -----------------------------------------------------
  const alerts: Attention[] = useMemo(() => session.latest.attention.filter((alert) => !dismissedAlerts.has(alert.id)), [session.latest.attention, dismissedAlerts])
  const notifiedThrough = useRef(-1)
  useEffect(() => {
    if (!notificationsOn || !activeRunId) return
    for (const alert of session.latest.attention) {
      if (alert.seq > notifiedThrough.current) {
        try { new Notification(`LoomWatch · ${alert.agentId}`, { body: alert.message, tag: `${activeRunId}:${alert.id}` }) } catch { /* permission may be revoked */ }
      }
    }
    notifiedThrough.current = session.lastSeq
  }, [session.latest.attention, session.lastSeq, notificationsOn, activeRunId])
  const enableNotifications = useCallback(async () => {
    if (notificationsOn) { setNotificationsOn(false); return }
    if (!('Notification' in window)) { setStartError('Notifications are unavailable in this browser.'); return }
    try { setNotificationsOn((await Notification.requestPermission()) === 'granted') } catch { setNotificationsOn(false) }
  }, [notificationsOn])

  const statusById = useMemo(() => new Map(projection.agents.map((agent) => [agent.id, `${nodeNames.get(agent.id) ?? agent.id}: ${agent.taskState.toLowerCase()}`])), [projection.agents, nodeNames])
  const priorStatuses = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const previous = priorStatuses.current
    priorStatuses.current = statusById
    if (!previous) return
    const changed = [...statusById].filter(([id, status]) => previous.get(id) !== status).map(([, status]) => status)
    if (changed.length === 0) return
    setStatusAnnouncement(changed.join('. '))
    const clear = window.setTimeout(() => setStatusAnnouncement(''), 3000)
    return () => window.clearTimeout(clear)
  }, [statusById])

  // ---- composer state ---------------------------------------------------------------------
  const filename = doc.path?.split('/').pop() ?? 'team'
  // §1.3: the blocker names the offending agents, so the preflight keeps their ids, not a count.
  const terminalIds = useMemo(
    () => (doc.mode === 'pipeline' ? doc.nodes.filter((node) => !doc.edges.some((edge) => edge.source === node.id)).map((node) => node.id) : []),
    [doc.mode, doc.nodes, doc.edges],
  )
  const terminals = doc.mode === 'pipeline' ? terminalIds.length : 1
  const composerState: ComposerState = useMemo(() => {
    if (history.unavailable) return { kind: 'unavailable', reason: history.unavailable }
    if (runView && !session.terminal && record) return { kind: 'busy', phase }
    if (runView && session.terminal) return { kind: 'terminal', phase }
    // §1.4/§1.6: the save and the start are two steps and stay legible as two. `pendingPrompt`
    // is the write; `starting` is the run creation, which on a clean document is the only step.
    if (pendingPrompt !== null) return { kind: 'saving', filename }
    if (starting) return { kind: 'starting' }
    if (!doc.path) return { kind: 'blocked', reason: 'Open or create a team first.' }
    if (doc.nodes.length === 0) return { kind: 'blocked', reason: 'Add an agent from the Library before running.' }
    if (!doc.isValid && problems.length > 0) return { kind: 'blocked', reason: `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before this team can run.`, action: { label: 'Review', run: () => setProblemsOpen(true) } }
    if (doc.mode === 'pipeline' && terminals === 0) return { kind: 'blocked', reason: 'A pipeline run needs exactly one final agent. Every agent in this one hands off to another, so it has none.' }
    if (doc.mode === 'pipeline' && terminals !== 1) return { kind: 'blocked', reason: `A pipeline run needs exactly one final agent. This one has ${terminals}: ${terminalIds.map((id) => nodeNames.get(id) ?? id).join(', ')}.`, action: { label: 'Show on canvas', run: () => { doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: terminalIds.includes(node.id) }))); void flow.fitView({ nodes: doc.nodes.filter((node) => terminalIds.includes(node.id)), padding: 0.35, maxZoom: 1, duration: 300 }) } } }
    if (doc.readOnlyReason) return { kind: 'blocked', reason: doc.readOnlyReason }
    if (doc.documentChipState === 'saving') return { kind: 'saving', filename }
    if (['dirty', 'new'].includes(doc.documentChipState)) return { kind: 'dirty', filename }
    return { kind: 'ready' }
  }, [history.unavailable, runView, session.terminal, record, phase, starting, pendingPrompt, doc, problems.length, terminals, terminalIds, nodeNames, filename, flow])

  // ---- commands + keys ----------------------------------------------------------------------
  const toggleLibrary = useCallback(() => window.dispatchEvent(new Event('loomwatch:toggle-library')), [])
  const actions = useMemo<CommandAction[]>(() => [
    // §1.2: the palette advertises ⌘↵, so it must do what ⌘↵ does. With nothing typed there is
    // no goal to run yet, and focusing the field is the honest half of the promise.
    { label: 'Run the team…', shortcut: '⌘↵', run: () => { if (composerText.trim()) void submit(); else document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus() }, disabled: !doc.path },
    { label: 'Run history', run: () => setHistoryOpen(true) },
    ...(runView ? [{ label: 'Back to the team canvas', shortcut: 'Esc', run: closeRun }] : []),
    { label: 'Add agent…', run: toggleLibrary, disabled: !doc.path || !editable },
    { label: 'Save', shortcut: '⌘S', run: () => void doc.save(), disabled: !doc.path || !editable || !doc.isValid },
    { label: 'Open team…', run: () => setOpenPathOpen(true) },
    { label: 'New team…', shortcut: '⌘N', run: () => { setNewName(''); if (doc.path) setNewTeamSheet(true); else setCreating(true) } },
    { label: 'Reload from disk', run: () => void doc.reloadFromDisk(), disabled: !doc.path || doc.saveState === 'new' },
    { label: 'Discard changes', run: () => setDiscardConfirm(true), disabled: !doc.path || !['dirty', 'invalid', 'conflict'].includes(doc.documentChipState) },
    { label: 'Next problem', shortcut: 'F8', run: () => cycleProblem(1), disabled: problems.length === 0 },
    { label: 'Fit view', shortcut: 'F', run: () => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }) },
    { label: 'Auto-layout', shortcut: '⌥⌘L', run: doc.layoutNodes, disabled: !editable || runView },
    { label: 'Toggle library', shortcut: '⌘\\', run: toggleLibrary, disabled: !doc.path || windowWidth < 768 },
    ...(layersVisible ? [{ label: 'Solo edge layer', shortcut: 'L', run: () => setSolo((current) => (current === 'both' ? 'configured' : current === 'configured' ? 'observed' : 'both')) }] : []),
    { label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', shortcut: '⌘⇧L', run: () => setThemeMode(theme === 'dark' ? 'light' : 'dark') },
    { label: 'Follow system appearance', run: () => setThemeMode('system') },
    { label: notificationsOn ? 'Disable notifications' : 'Enable notifications', run: () => void enableNotifications() },
    { label: 'Copy file path', run: () => { if (doc.path) void navigator.clipboard?.writeText(doc.path) }, disabled: !doc.path },
    { label: 'Show YAML', run: () => setYamlOpen(true), disabled: !doc.path },
    { label: 'Connections…', run: () => window.location.assign('/connections') },
  ], [doc, editable, flow, composerText, submit, toggleLibrary, windowWidth, runView, closeRun, cycleProblem, problems.length, theme, notificationsOn, enableNotifications, layersVisible])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      const editingText = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)
      if (mod && key === 'k') { event.preventDefault(); setPaletteOpen(true); return }
      if (mod && key === 's') { event.preventDefault(); if (editable) void doc.save(); return }
      if (mod && event.shiftKey && key === 'l') { event.preventDefault(); setSweeping(true); window.setTimeout(() => setSweeping(false), 340); setThemeMode(theme === 'dark' ? 'light' : 'dark'); return }
      if (mod && key === 'n') { event.preventDefault(); setNewName(''); if (doc.path) setNewTeamSheet(true); else setCreating(true); return }
      if (mod && key === 'p') { event.preventDefault(); setHistoryOpen((open) => !open); return }
      // §1.2: ⌘↵ submits from anywhere in the app, including a focused canvas — above the
      // `editingText` guard below, which would otherwise swallow it in every other field. The
      // composer's own textarea binds it directly (there it also serves Retry and New run), so
      // it is skipped here rather than submitted twice.
      if (mod && event.key === 'Enter') {
        if (!(event.target instanceof HTMLElement && event.target.closest('.lw-composer'))) { event.preventDefault(); void submit() }
        return
      }
      if (event.key === 'F8') { event.preventDefault(); cycleProblem(event.shiftKey ? -1 : 1); return }
      if (event.key === 'Escape') {
        if (pendingNodeDelete.length > 0) setPendingNodeDelete([])
        else if (discardConfirm) setDiscardConfirm(false)
        else if (paletteOpen) setPaletteOpen(false)
        else if (historyOpen) setHistoryOpen(false)
        else if (modeOpen) setModeOpen(false)
        else if (problemsOpen) setProblemsOpen(false)
        else if (yamlOpen) setYamlOpen(false)
        else if (compareOpen) setCompareOpen(false)
        else if (doc.refusal) doc.dismissRefusal()
        else if (inspectedEvidenceId) setInspectedEvidenceId(null)
        else if (provenanceOpen) setProvenanceOpen(false)
        else if (selectedNodes.length > 0 || selectedEdges.length > 0) clearSelection()
        else if (editingText) (event.target as HTMLElement).blur()
        else if (runView && session.terminal) closeRun()
        return
      }
      if (editingText) return
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) doc.redo(); else doc.undo(); return }
      if (mod && key === '\\') { event.preventDefault(); if (windowWidth >= 768) toggleLibrary(); return }
      if (mod && key === '0') { event.preventDefault(); void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 }); return }
      if (mod && (key === '+' || key === '=')) { event.preventDefault(); void flow.zoomIn({ duration: 200 }); return }
      if (mod && key === '-') { event.preventDefault(); void flow.zoomOut({ duration: 200 }); return }
      if (event.altKey && mod && key === 'l') { event.preventDefault(); if (editable && !runView) doc.layoutNodes(); return }
      if (layersVisible && key === 'l' && !mod && !event.altKey) { event.preventDefault(); setSolo((current) => (current === 'both' ? 'configured' : current === 'configured' ? 'observed' : 'both')); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && editable && !runView) {
        const selectedNodeIds = doc.nodes.filter((node) => node.selected).map((node) => node.id)
        const selectedEdgeIds = doc.edges.filter((edge) => edge.selected).map((edge) => edge.id)
        if (selectedNodeIds.length > 0) requestNodeDelete(selectedNodeIds)
        else if (selectedEdgeIds.length > 0) doc.onEdgesChange(selectedEdgeIds.map((id) => ({ id, type: 'remove' as const })))
        return
      }
      if (runView && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && session.lastSeq > 0) {
        event.preventDefault()
        const position = session.cursor === null ? session.lastSeq : session.cursor
        session.setCursor(event.key === 'ArrowLeft' ? Math.max(0, position - 1) : position + 1)
        return
      }
      if (event.key === 'Tab' && doc.nodes.length > 0 && !runView) {
        event.preventDefault()
        const orderedIds = doc.pipelineSteps.length > 0 ? doc.pipelineSteps.map((step) => step.id) : doc.nodes.map((node) => node.id)
        const currentIndex = orderedIds.findIndex((id) => doc.nodes.some((node) => node.id === id && node.selected))
        const nextId = orderedIds[(currentIndex + (event.shiftKey ? -1 : 1) + orderedIds.length) % orderedIds.length]
        doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === nextId })))
        const next = doc.nodes.find((node) => node.id === nextId)
        if (next) void flow.fitView({ nodes: [next], padding: 0.6, maxZoom: 1, duration: 200 })
        return
      }
      if (event.key === 'Enter') {
        if (pendingNodeDelete.length > 0) { deleteNodes(pendingNodeDelete); setPendingNodeDelete([]); return }
        if (discardConfirm) { setDiscardConfirm(false); void doc.reloadFromDisk(); return }
        const selected = doc.nodes.find((node) => node.selected)
        if (selected && editable && !runView) window.dispatchEvent(new CustomEvent('loomwatch:rename-agent', { detail: { id: selected.id } }))
        return
      }
      if (key === 'f' && !mod) {
        event.preventDefault()
        const selected = doc.nodes.filter((node) => node.selected)
        if (event.shiftKey && selected.length > 0) void flow.fitView({ nodes: selected, padding: 0.2, maxZoom: 1, duration: 300 })
        else void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doc, editable, flow, submit, toggleLibrary, paletteOpen, yamlOpen, compareOpen, windowWidth, clearSelection, discardConfirm, pendingNodeDelete, requestNodeDelete, deleteNodes, historyOpen, modeOpen, problemsOpen, inspectedEvidenceId, provenanceOpen, selectedNodes.length, selectedEdges.length, runView, session, closeRun, theme, cycleProblem, layersVisible])

  // §13: at tablet widths, allow either the Library sheet or the inspector, never both.
  useEffect(() => {
    if (inspecting && windowWidth >= 768 && windowWidth < 1024) window.dispatchEvent(new Event('loomwatch:close-library'))
  }, [inspecting, windowWidth])
  useEffect(() => {
    const closeInspector = () => { if (window.innerWidth < 768 || window.innerWidth >= 1024) return; clearSelection() }
    window.addEventListener('loomwatch:open-library', closeInspector)
    return () => window.removeEventListener('loomwatch:open-library', closeInspector)
  }, [clearSelection])

  const canvasActions: CanvasActions = useMemo(() => ({
    editable: editable && !runView, renameAgent: doc.renameAgent, touchField: doc.touchField, mode: doc.mode, stepById, nodeNames,
    inspectEvidence: (id) => { setInspectedEvidenceId(id); if (id) { doc.onNodesChange(doc.nodes.filter((node) => node.selected).map((node) => ({ id: node.id, type: 'select' as const, selected: false }))) } },
    toggleProvenance: () => setProvenanceOpen((open) => !open),
    reusePrompt,
  }), [editable, runView, doc, stepById, nodeNames, reusePrompt])

  const validationProblemCount = problems.length
  // TNG89 §6.3: the preflight blocker is assertive, and the polite channel is a queue
  // that announces every message in order — never a first-match, which dropped
  // everything below the first truthy candidate: during a live run, agent status churn
  // (held 3 s at a time) silently preempted save state, the validation blocker, disk
  // notices and start errors. Candidates are diffed per slot, so a message is queued
  // exactly when its condition becomes true or changes, and unrelated re-renders
  // neither re-announce it nor drop it.
  const politeCandidates = [
    doc.modeSwitchBanner ? 'Team changed to pipeline mode.' : null,
    statusAnnouncement || null,
    doc.documentChipState === 'saving' ? 'Saving team.' : null,
    doc.documentChipState === 'saved' ? 'Team saved.' : null,
    doc.documentChipState === 'error' ? 'Could not save team.' : null,
    doc.diskNotice,
    startError,
  ]
  const assertiveCandidates = [
    doc.documentChipState === 'invalid' ? `Team has ${validationProblemCount} validation problem${validationProblemCount === 1 ? '' : 's'}.` : null,
    doc.externalChange ? 'The team file changed on disk.' : null,
    doc.refusal?.message ?? null,
    alerts[0]?.message ?? null,
  ]
  const [politeAnnouncement, enqueuePolite] = useAnnouncementQueue()
  const [assertiveAnnouncement, enqueueAssertive] = useAnnouncementQueue()
  const priorPolite = useRef<(string | null)[]>([])
  const priorAssertive = useRef<(string | null)[]>([])
  useEffect(() => {
    const previous = priorPolite.current
    priorPolite.current = politeCandidates
    for (let index = 0; index < politeCandidates.length; index += 1) {
      const message = politeCandidates[index]
      if (message && message !== previous[index]) enqueuePolite(message)
    }
  })
  useEffect(() => {
    const previous = priorAssertive.current
    priorAssertive.current = assertiveCandidates
    for (let index = 0; index < assertiveCandidates.length; index += 1) {
      const message = assertiveCandidates[index]
      if (message && message !== previous[index]) enqueueAssertive(message)
    }
  })

  const historyEntries = useMemo(() => mergeHistory(history.records, history.sessions), [history.records, history.sessions])
  const leadAgent = projection.agents.find((agent) => agent.id === leadId)
  const lifecycleResult = phase === 'queued' || phase === 'starting' ? 'not started' : phase === 'running' ? (responseText ? 'streaming' : 'pending') : phase === 'succeeded' ? 'done' : phase
  const loadedYaml = doc.loadedYaml ?? ''
  const differ = doc.documentChipState === 'dirty' ? linesDiffer(loadedYaml, doc.yamlPreview) : 0

  // §9.5: a failed load has no canvas to return to — the only modal.
  if (doc.loadFailure) return <ParseFailureModal failure={doc.loadFailure} path={doc.path} />

  if (!doc.path) {
    return (
      <FirstRun
        harnessCount={harnesses.filter((harness) => harness.acpAvailable !== false).length}
        loading={harnessesLoading}
        harnessError={harnessesError}
        creating={creating}
        name={newName}
        onNameChange={setNewName}
        onStart={() => setCreating(true)}
        onCancel={() => setCreating(false)}
        onCreate={() => { doc.createNewDocument(newName); onDocumentOpen() }}
        onOpen={() => setOpenPathOpen(true)}
        onPalette={() => setPaletteOpen(true)}
      >
        {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
        {openPathOpen && <OpenTeamSheet onClose={() => setOpenPathOpen(false)} />}
      </FirstRun>
    )
  }

  const shellClass = [
    'lw-shell', `mode-${doc.mode}`, libraryDragging ? 'dragging' : '', nodeDragging ? 'node-dragging' : '', inspecting ? 'inspecting' : '', sweeping ? 'sweeping' : '',
    soloActive === 'configured' ? 'solo-configured' : soloActive === 'observed' ? 'solo-observed' : '', runView ? 'run-view' : 'compose-view',
    !runView || windowWidth >= 768 ? (libraryCollapsed ? 'lib-collapsed' : 'lib-open') : 'lib-hidden',
  ].filter(Boolean).join(' ')

  return (
    <CanvasActionsContext.Provider value={canvasActions}>
      <div className={shellClass} onDragEnter={(event) => { if (event.dataTransfer.types.includes(LIBRARY_DRAG_MIME) || event.dataTransfer.types.includes(EVIDENCE_DRAG_MIME)) setLibraryDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setLibraryDragging(false) }}>
        {runView && windowWidth < 768 ? (
          <RunColumn
            prompt={record?.prompt ?? projection.prompt ?? ''} attempt={attempt} phase={phase} branch={retryOf.get(activeRunId ?? '') ? 'Retry of an earlier run' : 'Initiating branch'} elapsed={elapsed} mode={session.mode}
            agents={graph.nodes.filter((node): node is AgentNode => node.type === 'agent')}
            evidenceByAgent={new Map(orderedAgentIds.map((id) => [id, projection.evidence.filter((item) => item.agentId === id)]))}
            ownerLabels={ownerLabels}
            output={(graph.nodes.find((node) => node.id === '__output') as OutputNode | undefined)?.data ?? { text: responseText, phase, phaseText: '', producer: null, producerLabel: 'the responder', mode: session.mode, streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: session.terminal }}
            projection={projection}
            selectedEvidenceId={inspectedEvidenceId}
            onInspectEvidence={(id) => setInspectedEvidenceId(id)}
            onSelectAgent={(id) => doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === id })))}
          />
        ) : (
        <div ref={canvasRef} role="application" aria-label={runView ? 'Run graph' : 'Team canvas'} className="lw-canvas">
          <ReactFlow
            nodes={graph.nodes}
            edges={visibleEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={editable && !runView ? doc.onConnect : undefined}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            deleteKeyCode={null}
            nodesDraggable={editable || runView}
            nodesConnectable={editable && !runView}
            edgesReconnectable={editable && !runView}
            nodesFocusable
            edgesFocusable={!runView}
            snapToGrid={!runView}
            snapGrid={[8, 8]}
            minZoom={0.25}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            colorMode={theme}
          >
            <Background variant={'dots' as never} gap={16} size={1} color="var(--color-ground-dot)" />
            {!runView && doc.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="ghost t-body"><span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span>Drag a harness here to add your first agent.</span><span className="t-meta">It becomes the entry point.</span></span></div>
              </div>
            )}
          </ReactFlow>
        </div>
        )}
        <div className="lw-sweep" aria-hidden="true" />

        <div aria-live="polite" aria-atomic="true" className="visually-hidden">{politeAnnouncement}</div>
        <div aria-live="assertive" className="visually-hidden">{assertiveAnnouncement}</div>

        <div className="bar-stack">
          {doc.externalChange && <ConflictBar filename={filename} onKeepMine={doc.keepMine} onUseDisk={() => void doc.useDisk()} onCompare={() => setCompareOpen(true)} />}
          {doc.readOnlyReason && !doc.fileGone && <div role="status" className="bar halt"><ChipDot state="readonly" /><span className="msg t-body-m">{doc.readOnlyReason}</span><span className="sub t-meta">Read-only. Pan and inspect still work.</span></div>}
          {harnessesError && !runView && <div role="status" className="bar halt"><ChipDot state="failed" /><span className="msg t-body-m">LoomWatch can't reach the daemon.</span><span className="sub t-mono-sm">{harnessesError}</span><span className="acts"><button type="button" className="btn" onClick={onRetryHarnesses}>Retry now</button></span></div>}
          {startError && <div role="alert" className="bar alert"><ChipDot state="failed" /><span className="msg t-body-m">{startError}</span><span className="acts"><button type="button" className="btn" onClick={() => setStartError(null)}>Dismiss</button></span></div>}
        </div>

        {(!runView || windowWidth >= 768) && (
          <Library harnesses={harnesses} harnessesLoading={harnessesLoading} harnessesError={harnessesError} onRetry={onRetryHarnesses} capabilityInventory={capabilityInventory} capabilitiesLoading={capabilitiesLoading} capabilitiesError={capabilitiesError} capabilitiesScannedAt={capabilitiesScannedAt} onRetryCapabilities={() => { onRetryCapabilities(); onRetryHarnesses() }} onDragStateChange={setLibraryDragging} onCollapsedChange={setLibraryCollapsed} evidenceMode={runView} observedEvidence={runView ? projection.evidence : []} onRevealEvidence={(id) => {
            const target = graph.nodes.find((node) => node.id === id)
            if (target) void flow.fitView({ nodes: [target], padding: 0.8, maxZoom: 1, duration: 300 })
            setInspectedEvidenceId(id)
          }} />
        )}

        <div className="pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-2" style={{ top: 'var(--lw-panel-inset)' }}>
          <DocumentSwitcher
            path={doc.path} saveState={doc.documentChipState} saveError={doc.saveError} linesDiffer={differ}
            entrypointProblem={doc.entrypointProblem} documentProblems={doc.documentProblems} fieldProblemsByAgent={doc.fieldProblemsByAgent} agentNames={nodeNames}
            isValid={doc.isValid} readOnlyReason={doc.readOnlyReason} fileGone={doc.fileGone} editingDisabled={windowWidth < 768}
            onSave={() => void doc.save()} onSaveCopy={() => setSaveCopyOpen(true)} onReload={() => void doc.reloadFromDisk()} onDiscard={() => void doc.reloadFromDisk()} onShowYaml={() => setYamlOpen(true)}
            onNewTeam={() => { setNewName(''); setNewTeamSheet(true) }} onSelectProblem={selectProblem} problemsOpen={problemsOpen} onProblemsOpenChange={setProblemsOpen}
          />
          {runView && (
            <LifecycleStrip attempt={attempt} phase={phase} leadTask={leadAgent?.taskState.toLowerCase() ?? (phase === 'queued' ? 'queued' : 'ready')} result={lifecycleResult} mode={session.mode} lastSeq={session.lastSeq} cursor={session.cursor} onCursor={session.setCursor} onClose={closeRun} costUsd={projection.totals.costUsd} elapsed={elapsed} />
          )}
          {doc.diskNotice && <p className="lw-notice t-meta" style={{ margin: 0 }}>{doc.diskNotice}</p>}
          {doc.entrypointProblem && doc.entrypointProblem.candidates.length > 0 && editable && !runView && <EntrypointProblemBar problem={doc.entrypointProblem} onPromote={doc.promoteEntrypoint} />}
          {doc.modeSwitchBanner && <p className="mode-switch-note t-meta" style={{ margin: 0, pointerEvents: 'auto' }}>Drawn edges now sequence this team. <code>dispatch</code> and <code>handoff</code> are withdrawn.</p>}
          {doc.pendingEdgeRemoval && (
            <div role="alert" className="e2 pop-inline t-body" style={{ pointerEvents: 'auto', borderRadius: 'var(--r-md)' }}>
              <span>Removing the last edge returns this team to self-organizing.</span>
              <button type="button" className="btn btn-primary" onClick={doc.undoLastEdgeRemoval}>Undo</button>
              <button type="button" className="btn" onClick={doc.keepLastEdgeRemoval}>Keep it</button>
            </div>
          )}
        </div>

        {inspectedNode && !inspectedEvidence && (
          <Inspector
            node={inspectedNode} isEntrypoint={inspectedNode.id === doc.entrypoint} fieldProblems={doc.fieldProblemsByAgent.get(inspectedNode.id)} readOnly={!editable || runView} pipeline={doc.mode === 'pipeline'}
            onFieldBlur={(field) => doc.touchField(inspectedNode.id, field)} onRename={(field, value) => doc.renameAgent(inspectedNode.id, field, value)} onModelChange={(value) => doc.updateAgentModel(inspectedNode.id, value)}
            onCwdChange={(value) => doc.updateAgentCwd(inspectedNode.id, value)} onBudgetChange={(value) => doc.updateAgentBudget(inspectedNode.id, value)} onWarnAtChange={(value) => doc.updateAgentWarnAt(inspectedNode.id, value)}
            onAllowRecruitingChange={(value) => doc.updateAgentAllowRecruiting(inspectedNode.id, value)} onPromoteEntrypoint={() => doc.promoteEntrypoint(inspectedNode.id)} onDelete={() => requestNodeDelete([inspectedNode.id])}
            onClose={() => doc.onNodesChange([{ id: inspectedNode.id, type: 'select', selected: false }])}
          />
        )}
        {inspectedEvidence && <ActivityPanel evidence={inspectedEvidence} ownerLabel={ownerLabels.get(inspectedEvidence.agentId) ?? inspectedEvidence.agentId} onClose={() => setInspectedEvidenceId(null)} />}
        {provenanceOpen && !inspectedEvidence && !inspectedNode && runView && (
          <ProvenancePanel projection={projection} ownerLabels={ownerLabels} onInspect={(id) => setInspectedEvidenceId(id)} onClose={() => setProvenanceOpen(false)} />
        )}

        {alerts.length > 0 && (
          <div className="panel e1" style={{ left: 'var(--lw-panel-inset)', bottom: 'calc(var(--lw-panel-inset) + 72px)', width: 320, maxHeight: '40vh', overflow: 'auto', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }} role="region" aria-label={`Attention, ${alerts.length}`}>
            <span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Attention · {alerts.length}</span>
            {alerts.map((alert) => (
              <div key={alert.id} className="rt-strip alert t-meta" style={{ borderTop: 0, padding: '6px 8px', borderRadius: 'var(--r-sm)', background: 'var(--color-panel-solid)', alignItems: 'flex-start' }}>
                <span className="msg" style={{ whiteSpace: 'normal' }}><b style={{ color: 'var(--color-ink)' }}>{nodeNames.get(alert.agentId) ?? alert.agentId}</b> · {alert.message}</span>
                <button type="button" className="link t-meta" style={{ flex: 'none' }} onClick={() => setDismissedAlerts((ids) => new Set([...ids, alert.id]))}>Dismiss</button>
              </div>
            ))}
          </div>
        )}

        {layersVisible && <LayerLegend configured={doc.edges.length} observed={observedCount} solo={soloActive} onSolo={setSolo} />}
        <ViewControls inspecting={inspecting} />

        {doc.refusal && <div className="pointer-events-none absolute inset-x-0 z-40 flex justify-center" style={{ bottom: 'calc(var(--lw-panel-inset) + 72px)' }}><EdgeRefusalPopover refusal={doc.refusal} onPromote={doc.promoteEntrypoint} onDismiss={doc.dismissRefusal} /></div>}

        <Composer
          note={!runView && composerState.kind === 'ready' && routine ? `Routine: ${routine.enabled ? routine.describe : 'paused'} · next ${describeNextFire(routine.nextAt)}${routine.deliver?.notion ? ' · delivers to Notion' : ''}` : undefined}
          mode={doc.mode} stepCount={doc.pipelineSteps.length || doc.nodes.length} anomalyCount={anomalies.length} state={composerState}
          value={composerText} onChange={setComposerText} onSubmit={() => void submit()} onStop={() => void stop()} onRetry={retry} onNewRun={() => void submit()}
          onOpenMode={() => { setModeOpen((open) => !open); setHistoryOpen(false) }} onOpenHistory={() => { setHistoryOpen((open) => !open); setModeOpen(false) }} modeOpen={modeOpen} historyOpen={historyOpen} switchBanner={doc.modeSwitchBanner}
        >
          {modeOpen && (
            <ModePopover mode={doc.mode} steps={doc.pipelineSteps} nodeNames={nodeNames} entrypointName={doc.entrypoint ? nodeNames.get(doc.entrypoint) ?? doc.entrypoint : null} guards={doc.teamGuards} budget={doc.teamBudget} anomalies={anomalies} readOnly={!editable} onUpdateGuards={doc.updateTeamGuards} onUpdateBudget={doc.updateTeamBudget} onClose={() => setModeOpen(false)} schedule={routine} onRunRoutineNow={() => void runRoutineNow()} routineBusy={routineBusy} />
          )}
          {historyOpen && (
            <RunHistory entries={historyEntries} currentId={activeRunId} loading={!history.loaded} error={history.error ?? history.unavailable} onOpen={(id) => { setHistoryOpen(false); showRun(id) }} onClose={() => setHistoryOpen(false)} />
          )}
        </Composer>

        {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
        {discardConfirm && <InlineConfirm message="Discard changes and reload from disk?" confirmLabel="Discard changes" onConfirm={() => { setDiscardConfirm(false); void doc.reloadFromDisk() }} onCancel={() => setDiscardConfirm(false)} />}
        {pendingNodeDelete.length > 0 && <InlineConfirm message={`Delete ${pendingNodeDelete.length === 1 ? 'this node and its connections' : `${pendingNodeDelete.length} nodes and their connections`}?`} confirmLabel="Delete" onConfirm={() => { deleteNodes(pendingNodeDelete); setPendingNodeDelete([]) }} onCancel={() => setPendingNodeDelete([])} />}
        {openPathOpen && <OpenTeamSheet onClose={() => setOpenPathOpen(false)} />}
        {newTeamSheet && <NewTeamSheet name={newName} onNameChange={setNewName} onClose={() => setNewTeamSheet(false)} onCreate={() => { doc.createNewDocument(newName); setNewTeamSheet(false); showRun(null); onDocumentOpen() }} />}
        {saveCopyOpen && <SaveCopySheet error={doc.saveError} onClose={() => setSaveCopyOpen(false)} onSave={doc.saveCopy} />}
        {yamlOpen && <YamlSheet title={yamlHighlightLine ? `YAML preview · line ${yamlHighlightLine}` : 'YAML preview'} yaml={doc.yamlPreview} highlightLine={yamlHighlightLine} onClose={() => { setYamlOpen(false); setYamlHighlightLine(null) }} />}
        {compareOpen && doc.externalChange && (
          <YamlSheet title="Disk ↔ in-memory YAML" yaml={unifiedYamlDiff(doc.externalChange.diskYaml, doc.yamlPreview)} onClose={() => setCompareOpen(false)} footer={<ConflictSheetFooter onKeepMine={doc.keepMine} onUseDisk={() => void doc.useDisk()} />} />
        )}
      </div>
    </CanvasActionsContext.Provider>
  )
}

function ConflictSheetFooter({ onKeepMine, onUseDisk }: { onKeepMine: () => void; onUseDisk: () => void }) {
  const [confirmDisk, setConfirmDisk] = useState(false)
  return (
    <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--color-hairline)' }}>
      <button type="button" className="btn" onClick={onKeepMine}>Keep mine</button>
      <button type="button" className={`btn ${confirmDisk ? 'btn-danger' : ''}`} onClick={() => (confirmDisk ? onUseDisk() : setConfirmDisk(true))} style={confirmDisk ? { color: 'var(--color-alert)' } : undefined}>{confirmDisk ? 'Discard my edits?' : 'Use disk'}</button>
    </footer>
  )
}

function InlineConfirm({ message, confirmLabel, onConfirm, onCancel }: { message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-label={message} className="pointer-events-none absolute inset-x-0 z-50 flex justify-center" style={{ bottom: 'calc(var(--lw-panel-inset) + 72px)' }}>
      <div className="e2 lw-confirm t-body" style={{ pointerEvents: 'auto' }}>
        <span>{message}</span>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger-fill" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  )
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="lw-scrim dim" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label} className="pop e2" style={{ left: '50%', top: '22%', transform: 'translateX(-50%)', width: 'min(480px, calc(100vw - 32px))', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
        {children}
      </div>
    </div>
  )
}

function OpenTeamSheet({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    fetchTeamsDiscovery().then((result) => { if (!cancelled) setFiles(result.files) })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  const matches = files.filter((file) => file.toLowerCase().includes(path.toLowerCase()))
  return (
    <Sheet label="Open team" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (path.trim()) window.location.assign(`/?path=${encodeURIComponent(path.trim())}`) }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <label className="field"><span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Open team path</span><input autoFocus className="input mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="research-team.yaml" /><span className="hint t-meta">Relative to the daemon teams directory.</span></label>
        <div className="pop-list" style={{ padding: 0, maxHeight: 192 }} aria-label="Available team files">
          {loading && <p role="status" className="pop-empty t-meta">Finding teams…</p>}
          {error && <p role="alert" className="pop-empty t-meta" style={{ color: 'var(--color-alert)' }}>{error}</p>}
          {!loading && !error && matches.length === 0 && <p className="pop-empty t-meta">No matching team files.</p>}
          {matches.map((file) => <button key={file} type="button" onClick={() => setPath(file)} className={`pop-row ${path === file ? 'current' : ''}`}><span className="name t-mono">{file}</span></button>)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!path.trim()}>Open</button></div>
      </form>
    </Sheet>
  )
}

function SaveCopySheet({ onClose, onSave, error }: { onClose: () => void; onSave: (path: string) => Promise<boolean>; error: string | null }) {
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)
  return (
    <Sheet label="Save a copy" onClose={onClose}>
      <form onSubmit={async (event) => { event.preventDefault(); setAttempted(true); if (!path.trim() || saving) return; setSaving(true); const saved = await onSave(path.trim()); setSaving(false); if (saved) onClose() }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <label className="field"><span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Save copy as</span><input autoFocus className="input mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="research-team-copy.yaml" /><span className="hint t-meta">Relative to the daemon teams directory.</span></label>
        {attempted && error && <p role="alert" className="t-meta" style={{ color: 'var(--color-alert)', margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!path.trim() || saving}>{saving ? 'Saving…' : 'Save a copy'}</button></div>
      </form>
    </Sheet>
  )
}

function NewTeamSheet({ name, onNameChange, onClose, onCreate }: { name: string; onNameChange: (name: string) => void; onClose: () => void; onCreate: () => void }) {
  return (
    <Sheet label="New team" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate() }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <label className="field"><span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>New team name</span><input autoFocus className="input" value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Research and review" /><span className="hint t-meta" style={{ color: 'var(--color-accent)' }}>Creating a new document replaces the current in-memory canvas.</span></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!name.trim()}>Create</button></div>
      </form>
    </Sheet>
  )
}

export { STORY }
