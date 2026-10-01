import { Background, getNodesBounds, getViewportForBounds, MarkerType, ReactFlow, useNodesInitialized, useReactFlow, type Edge, type EdgeChange, type Node, type NodeChange, type OnNodeDrag } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchHarnessModels, type DetectedHarness, type HarnessModels } from '../lib/harnesses'
import { briefFileNameFor, exportPack, fetchMemory, fetchNoteHistory, fetchNotes, fetchRunCheckpoints, fetchRunContext, reviseNote, writeMemoryFile, type Checkpoint, type ContextPacket, type MemoryView, type Note, type NotebookView } from '../lib/memory/client'
import type { AgentNode } from '../lib/library/nodeFromDrop'
import type { CapabilityInventory, DetectedCapability } from '../lib/library/client'
import { askRunAgent, answerRun, cancelRun, describeNextFire, findRunByStartKey, isTerminalRun, newStartKey, RunApiError, runScheduleNow, scheduleForPath, STALE_TEAM_REVISION, startRun, useSchedules } from '../lib/runs/client'
import { ownerLabelFor } from '../lib/runs/graph'
import { appLabelForAgent, harnessIdForAgent, modelOptionsForAgent } from '../lib/models'
import type { EvidenceNode, MoreNode, OutputNode, PromptNode, RunNode, WeftEdge } from '../lib/runs/graph'
import { causalOrder, DOCK, dockAnchors, fanEvidence, helperPositions, historicalRunPositions } from '../lib/runs/runOverlay'
import { historyRunUrl, mergeHistory, threadHistory } from '../lib/runs/history'
import { useRunHistory } from '../lib/runs/useRunHistory'
import { useRunSession } from '../lib/runs/useRunSession'
import { teamDisplayName } from '../lib/team-file/client'
import { snapToGrid } from '../lib/grid'
import { SCHEDULE_CARD } from '../lib/team-file/schedule'
import { reviewProblems, yamlLineForPath, type ReviewProblem } from '../lib/team-file/problems'
import { pipelineTerminal } from '../lib/team-file/pipelineOrder'
import { unifiedYamlDiff } from '../lib/team-file/diff'
import type { AgentConfig, AgentStatus } from '../lib/team-file/types'
import { useTeamDocument } from '../lib/team-file/useTeamDocument'
import { organizePipeline, type Positions } from '../lib/composer-layout/organize'
import { useComposerLayout } from '../lib/composer-layout/useComposerLayout'
import { CAPABILITY_CARD, RELATION, capabilityNodeId, freeCapabilitySlot, refuseCapabilityEdge, type CapabilityDragPayload, type CapabilityNodeConfig, type MemoryRef } from '../lib/composer-layout/types'
import { setThemeMode, useTheme } from '../lib/theme'
import { useAnnouncementQueue } from '../lib/useAnnouncementQueue'
import type { AgentField } from '../lib/team-file/validation'
import { recordedReplyText, formatElapsed, isNotebookWrite, type Attention, type Evidence, type RunPhase, type TaskState } from '../lib/watch/events'
import { CanvasActionsContext, type CanvasActions } from './canvas/CanvasActionsContext'
import { CommandPalette, type CommandAction } from './canvas/CommandPalette'
import { ConflictBar } from './canvas/ConflictBar'
import { DocumentSwitcher } from './canvas/DocumentSwitcher'
import { EdgeRefusalPopover } from './canvas/EdgeRefusalPopover'
import { EntrypointProblemBar } from './canvas/EntrypointProblemBar'
import { Home } from './home/Home'
import { openTeam, useTeamList } from '../lib/team-file/useTeamList'
import { NewTeamDialog } from './home/NewTeamDialog'
import { Inspector } from './canvas/Inspector'
import { CapabilityInspector, type InspectedCapability } from './canvas/CapabilityInspector'
import { LayerLegend, type LayerSolo } from './canvas/LayerLegend'
import { ParseFailureModal } from './canvas/ParseFailureModal'
import { ScheduleNodeCard, type ScheduleNode } from './canvas/ScheduleNodeCard'
import { SchedulePanel } from './canvas/SchedulePanel'
import { type CapabilityNode } from './canvas/capabilityNode'
import { ViewControls } from './canvas/ViewControls'
import { YamlSheet } from './canvas/YamlSheet'
import { BuildProvEdgeView, ProvEdgeView, WarpEdgeView, WeftEdgeView } from './canvas/edges'
import { BuildAgentCard, BuildCapabilityCard, BuildOutputCard } from './canvas/BuildNodeCard'
import { BuildResourceInspector } from './canvas/BuildResourceInspector'
import { BuildInspector } from './canvas/BuildInspector'
import { ComponentPalette } from './library/ComponentPalette'
import { ArrowRight, Menu as MenuIcon, Play, Wrench, X } from 'lucide-react'
import { Composer, type ComposerState } from './composer/Composer'
import { ModePopover } from './composer/ModePopover'
import { RunHistory } from './composer/RunHistory'
import { CAPABILITY_DRAG_MIME, EVIDENCE_DRAG_MIME, Library, LIBRARY_DRAG_MIME } from './library'
import { BriefEditStrip } from './memory/BriefEditStrip'
import { CheckpointStrip } from './memory/CheckpointStrip'
import { MemoryPanel } from './memory/MemoryPanel'
import { ReviewStrip } from './memory/ReviewStrip'
import { ActivityPanel } from './run/ActivityPanel'
import { HandoverPanel } from './run/HandoverPanel'
import { LifecycleStrip } from './run/LifecycleStrip'
import { ProvenancePanel } from './run/ProvenancePanel'
import { DeliveryLane } from './run/DeliveryLane'
import { EvidenceNodeCard, MoreEvidenceCard, OutputNodeCard, PromptNodeCard, RunNodeCard } from './run/StoryNodes'
import { ChipDot } from './ui/glyphs'

// One canvas anatomy for both surfaces. Run ("Full trace") draws the team the operator composed,
// so it must be recognisably the same object: the agent and capability cards are the Build cards,
// with the run's projected state layered onto them. Only the nodes a run alone owns — the attempt,
// its evidence and the response it produced — have a Run-only renderer, and only the response node
// differs between the two, because before a run there is no answer to read.
const nodeTypes = { agent: BuildAgentCard, schedule: ScheduleNodeCard, capability: BuildCapabilityCard, prompt: PromptNodeCard, run: RunNodeCard, evidence: EvidenceNodeCard, more: MoreEvidenceCard, response: OutputNodeCard }
// Run keeps the provenance edge's own routing — the arc onto the Output node's top handle, the
// resource lane — because those carry run facts. The Build vocabulary and label chrome are CSS,
// scoped to `.build-graph`, which both surfaces set.
const edgeTypes = { warp: WarpEdgeView, weft: WeftEdgeView, prov: ProvEdgeView }
const buildNodeTypes = { ...nodeTypes, response: BuildOutputCard }
const buildEdgeTypes = { ...edgeTypes, prov: BuildProvEdgeView }
// Planned capability wiring: the same quiet neutral stroke as a story edge, carrying the one
// relationship word the typed matrix allows for that target kind (TNG-122 §4).
const PLAN_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 13, height: 13 }
const WARP_MARKER = { type: MarkerType.ArrowClosed, color: 'var(--color-warp)', width: 14, height: 14 }
const WEFT_MARKER = { type: MarkerType.Arrow, color: 'var(--color-accent)', width: 16, height: 16 }
const PROV_MARKER = { type: MarkerType.Arrow, color: 'var(--color-warp)', width: 14, height: 14 }
const LIVE_MARKER = { type: MarkerType.Arrow, color: 'var(--color-live)', width: 14, height: 14 }
const EMPTY_CAPABILITY_INVENTORY: CapabilityInventory = { skills: [], tools: [], sources: [] }

function capabilityEdgeId(from: string, to: string): string {
  return `capability:${from}->${to}`
}

interface WorkspaceProps {
  harnesses: DetectedHarness[]
  /** PATH entries the daemon actually scanned, for the Library's "Show search path". */
  harnessSearchPath?: string[]
  /** Harness ids the daemon looked for, so "Not installed" is the daemon's list, not the UI's. */
  knownHarnessIds?: string[]
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

/**
 * One stable key for "which memory is this", so a sidecar card and a `memory.inherits` entry that
 * name the same source are recognised as one thing.
 *
 * Prefixed by kind: a team called `onboarding` and a pack folder called `onboarding` are different
 * sources, and a bare name would silently merge them.
 */
function memoryKey(memory: MemoryRef | undefined): string {
  if (memory?.team) return `team:${memory.team}`
  if (memory?.pack) return `pack:${memory.pack}`
  return ''
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

export function Workspace({ harnesses, harnessSearchPath = [], knownHarnessIds = [], harnessesLoading, harnessesError, onRetryHarnesses, capabilityInventory = EMPTY_CAPABILITY_INVENTORY, capabilitiesLoading = false, capabilitiesError = null, capabilitiesScannedAt = null, onRetryCapabilities = () => {}, onDocumentOpen, initialRunId, initialHistoryOpen = false }: WorkspaceProps) {
  const doc = useTeamDocument()
  const flow = useReactFlow()
  const { resolved: theme } = useTheme()
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)
  const editable = !doc.readOnlyReason

  // ---- chrome state --------------------------------------------------------------------
  const [outputEditorOpen, setOutputEditorOpen] = useState(false)
  const outputPlanRef = useRef<{ name: string; format: string } | undefined>(undefined)
  const [workspaceMenu, setWorkspaceMenu] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [openPathOpen, setOpenPathOpen] = useState(false)
  const [newTeamSheet, setNewTeamSheet] = useState(false)
  const [saveCopyOpen, setSaveCopyOpen] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [pendingNodeDelete, setPendingNodeDelete] = useState<string[]>([])
  const [libraryDragging, setLibraryDragging] = useState(false)
  const [nodeDragging, setNodeDragging] = useState(false)
  const nodeDraggingRef = useRef(false)
  // React Flow keeps a synthetic node hidden until it has been measured, and a controlled `nodes`
  // prop rebuilt from scratch each render loses that measurement unless we hand it back. Agent
  // nodes get this for free because their `dimensions` changes reach `doc.onNodesChange`; every
  // node the document does not own — the schedule card, capability cards, run/evidence cards —
  // needs its size remembered here or it can settle at `visibility: hidden`.
  const [synthMeasurements, setSynthMeasurements] = useState<Record<string, { width: number; height: number }>>({})
  const [libraryCollapsed, setLibraryCollapsed] = useState(true)
  const [solo, setSolo] = useState<LayerSolo>('both')
  const [sweeping, setSweeping] = useState(false)
  const [notificationsOn, setNotificationsOn] = useState(false)
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
  const [problemCursor, setProblemCursor] = useState(-1)
  const problemFieldRef = useRef<{ agentId: string; field: AgentField } | null>(null)
  const [problemFocusRequest, setProblemFocusRequest] = useState(0)
  /**
   * An agent whose full settings were opened from somewhere else — today, "Fix in Build" on an
   * Attention alert. Build normally opens the short panel first, which does not contain the
   * field being sent to, and the operator arrives with no idea why they are looking at it.
   */
  const [forcedInspectorField, setForcedInspectorField] = useState<{ agentId: string; field: AgentField; hint: string } | null>(null)
  const [yamlHighlightLine, setYamlHighlightLine] = useState<number | null>(null)
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false)
  const [scheduleSaveAttempt, setScheduleSaveAttempt] = useState(0)
  const [scheduleSaved, setScheduleSaved] = useState(false)
  const handledScheduleSaveRef = useRef(0)
  const scheduleWasOpenRef = useRef(false)
  const [schedulePath, setSchedulePath] = useState<string | null>(null)
  const [selectedCapabilities, setSelectedCapabilities] = useState<ReadonlySet<string>>(new Set())
  const [selectedCapabilityEdgeIds, setSelectedCapabilityEdgeIds] = useState<ReadonlySet<string>>(new Set())
  const [inspectedCapability, setInspectedCapability] = useState<InspectedCapability | null>(null)
  const [planRefusal, setPlanRefusal] = useState<string | null>(null)
  const [modelCatalog, setModelCatalog] = useState<HarnessModels & { error: string | null }>({ harnessId: '', models: [], error: null })
  const modelCatalogCache = useRef(new Map<string, Omit<HarnessModels, 'harnessId'> & { error: string | null }>())
  const [modelCatalogRetry, setModelCatalogRetry] = useState(0)

  // ---- run state -----------------------------------------------------------------------
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId)
  const [runSetup, setRunSetup] = useState(false)
  const [runPresentation, setRunPresentation] = useState<'delivery' | 'trace'>('delivery')
  const [lastOpenedRun, setLastOpenedRun] = useState<{ id: string; path: string | null } | null>(initialRunId ? { id: initialRunId, path: doc.path } : null)
  const [composerText, setComposerText] = useState('')
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const answerInFlight = useRef(false)
  const [answerSending, setAnswerSending] = useState(false)
  const [starting, setStarting] = useState(false)
  // §1.6: the start key of the attempt in hand, surviving a failed POST so the re-press is the
  // same attempt. Cleared once the daemon answers with a run id.
  const startAttempt = useRef<{ identity: string; key: string } | null>(null)
  // §15.2.1: the *configured* graph's positions are the document's in every state, so what is left
  // here is presentation-only: the two docked anchors, the Run card, and the evidence cards the
  // operator has dragged out of their fan. `runPositions` — which used to hold every agent's
  // run-time position and move the design the moment a run opened — is gone.
  const [overlayPositions, setOverlayPositions] = useState<Record<string, { x: number; y: number }>>({})
  // §15.2.3: evidence folds to a count and fans for one agent at a time. This is that one agent.
  const [fannedAgentId, setFannedAgentId] = useState<string | null>(null)
  const [inspectedEvidenceId, setInspectedEvidenceId] = useState<string | null>(null)
  const [handoverAgentId, setHandoverAgentId] = useState<string | null>(null)
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  // The mid-run Brief edit: what was rewritten and when, so the strip can say when it lands.
  const [briefEdit, setBriefEdit] = useState<{ title: string; at: Date } | null>(null)
  // Which agents this run stored a context packet for. The packet inspector used to open only
  // from a stage's handover chip, so the entrypoint — which is handed nothing and still has a
  // packet — had no entry point at all (docs/TEAM_MEMORY.md, known gaps).
  const [packetAgents, setPacketAgents] = useState<{ runId: string; ids: string[]; notes: Record<string, number> } | null>(null)
  // The Notebook, read over REST like the Brief. Notes never ride the WebSocket: an incoming bus
  // `memory_write` on the run stream is an invalidation hint and nothing more, which is what keeps
  // docs/WEBSOCKET_SCHEMA.md frozen.
  const [notesRead, setNotesRead] = useState<{ path: string; view: NotebookView | null; error: string | null } | null>(null)
  const [notesGeneration, setNotesGeneration] = useState(0)
  /** Runs whose review strip the operator has already dealt with, so it does not come back. */
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set())
  const [retryOf] = useState<Map<string, string>>(() => new Map())
  /** Where the next follow-up starts: `null` is the whole pipeline, a stage id is "from <stage>". */
  const [followUpTarget, setFollowUpTarget] = useState<string | null>(null)
  /** The stopped run's checkpoints, read over REST so the strip can offer to continue from one. */
  const [checkpoints, setCheckpoints] = useState<{ runId: string; rows: Checkpoint[] } | null>(null)
  const history = useRunHistory(historyOpen)
  const schedules = useSchedules()
  const [routineBusy, setRoutineBusy] = useState(false)
  const inferredResponder = doc.mode === 'pipeline'
    ? pipelineTerminal(doc.nodes.map((node) => node.id), doc.edges.map((edge) => ({ from: edge.source, to: edge.target })), doc.entrypoint)
    : doc.entrypoint
  const responderFromDoc = doc.responder ?? inferredResponder
  const session = useRunSession(activeRunId, responderFromDoc)
  const record = session.record
  const waiting = record?.status === 'running' ? record.waitingOn ?? null : null
  const projection = session.projection
  const runView = activeRunId !== null
  const routine = useMemo(() => scheduleForPath(schedules.entries, doc.path), [schedules.entries, doc.path])
  // The registry knows the canonical responder for its own runs; history falls back to the document.
  const responderId = record?.responder ?? responderFromDoc

  /**
   * A stopped or failed run's checkpoints, read over REST.
   *
   * Read once the run is terminal and not before: a checkpoint is written at a stage boundary, so
   * asking mid-run would report the boundaries the run has passed rather than where it stopped.
   * Failed *and* cancelled are included — a run that died is exactly the one worth continuing —
   * and a succeeded run is not, because there is nothing stopped about it.
   */
  useEffect(() => {
    if (!activeRunId || !record || !['failed', 'cancelled'].includes(record.status)) return
    let cancelled = false
    void fetchRunCheckpoints(activeRunId)
      // Guarded at the I/O edge rather than downstream: this is the one place a daemon answering
      // something other than a list can be turned into "no checkpoints", which is the honest
      // reading and keeps a malformed 200 from taking the canvas down.
      .then((rows) => { if (!cancelled) setCheckpoints({ runId: activeRunId, rows: Array.isArray(rows) ? rows : [] }) })
      // A daemon with no archive answers 503. The strip simply does not appear; there is nothing
      // useful to say about a checkpoint that was never stored.
      .catch(() => { if (!cancelled) setCheckpoints({ runId: activeRunId, rows: [] }) })
    return () => { cancelled = true }
  }, [activeRunId, record])

  /** Every route into or out of a run passes through here so per-run view state resets together. */
  const showRun = useCallback((runId: string | null) => {
    setActiveRunId(runId)
    setRunPresentation('delivery')
    setRunSetup(false)
    if (runId) setLastOpenedRun({ id: runId, path: doc.path })
    writeRunToUrl(runId)
    setOverlayPositions({})
    setFannedAgentId(null)
    setInspectedEvidenceId(null)
    setProvenanceOpen(false)
    setDismissedAlerts(new Set())
    setBriefEdit(null)
    // A follow-up target belongs to the run it was chosen for: carrying "from Writer" into the
    // next run would silently skip stages of a run the operator never chose it for.
    setFollowUpTarget(null)
    setCheckpoints(null)
    // Solo is per-run view state too: a layer soloed in one story must not bleed into the next.
    setSolo('both')
  }, [doc.path])
  // The library is composition chrome; once a run is on screen it yields (the prototype's run
  // screens open with the rail). Keyed on the path too: before the document loads there is
  // no Library mounted to hear the event.
  // The full trace mounts its own Library, which would otherwise reopen in whatever state it was
  // last left; reviewing a run starts with the graph, not the catalogue.
  useEffect(() => {
    if (activeRunId && doc.path) window.dispatchEvent(new Event('loomwatch:close-library'))
  }, [activeRunId, doc.path, runPresentation])

  useEffect(() => {
    const resize = () => { setWindowWidth(window.innerWidth); setWindowHeight(window.innerHeight) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // ---- starting a run: there is no "run without saving" (TNG89 §1.4) ------------------
  const launch = useCallback(async (prompt: string, parent?: string | null, expectedRevision: string | null = null, lineage?: { followsRunId?: string | null; startAt?: string | null; fromCheckpointId?: string | null }) => {
    if (!doc.path) return
    // §1.6: one start key per attempt, held for the life of the attempt. An attempt is this
    // prompt against this revision of this file, so a re-press after a lost response carries the
    // SAME key and the daemon answers with the run it already started (200) instead of starting a
    // second one. A connection loss during submit never retries blind.
    // The lineage is part of the attempt's identity: "shorter" as a whole-pipeline follow-up and
    // "shorter" as a follow-up from Writer are different requests, and one start key for both
    // would make the second a 409 conflict instead of a run.
    const identity = `${doc.path}\0${parent ?? ''}\0${expectedRevision ?? ''}\0${lineage?.followsRunId ?? ''}\0${lineage?.startAt ?? ''}\0${lineage?.fromCheckpointId ?? ''}\0${prompt}`
    const attempt = startAttempt.current?.identity === identity ? startAttempt.current : { identity, key: newStartKey() }
    startAttempt.current = attempt
    setStarting(true)
    setStartError(null)
    try {
      const created = await startRun(doc.path, prompt, { startKey: attempt.key, expectedRevision, retryOfRunId: parent, ...lineage })
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
    const outputPlan = outputPlanRef.current
    const request = outputPlan ? `${prompt}\n\nRequested deliverable: ${outputPlan.name}\nFormat: ${outputPlan.format}` : prompt
    await launch(request, parent, doc.currentRevision())
  }, [composerText, doc, launch, activeRunId, record?.status, starting, pendingPrompt])

  const stop = useCallback(async () => {
    if (!activeRunId) return
    try { session.applyRecord(await cancelRun(activeRunId)) } catch (caught) { setStartError(caught instanceof Error ? caught.message : String(caught)) }
  }, [activeRunId, session])

  const sendAnswer = useCallback(async (sendBack?: string) => {
    // Approving a review stop needs no comment; the daemon still requires words, so the approval
    // is said explicitly. Sending work back, or answering an agent's question, needs real text.
    const text = composerText.trim() || (waiting?.kind === 'review_stop' && !sendBack ? 'Approved. Continue as planned.' : '')
    if (!activeRunId || !waiting || !text || answerInFlight.current) return
    answerInFlight.current = true
    setAnswerSending(true)
    setStartError(null)
    try {
      const next = await answerRun(activeRunId, waiting.node, text, sendBack)
      session.applyRecord(next)
      if (next.runId !== activeRunId) showRun(next.runId)
      setComposerText('')
      void history.refresh()
    } catch (error) { setStartError(error instanceof Error ? error.message : String(error)) }
    finally { answerInFlight.current = false; setAnswerSending(false) }
  }, [activeRunId, waiting, composerText, session, history, showRun])

  const replyToAgent = useCallback(async (agentId: string) => {
    if (!activeRunId || !composerText.trim() || answerInFlight.current) return
    answerInFlight.current = true
    setAnswerSending(true)
    setStartError(null)
    try {
      await askRunAgent(activeRunId, agentId, composerText.trim())
      setComposerText('')
      setStatusAnnouncement('Reply received. Open the agent’s events to read the conversation.')
    } catch (error) { setStartError(error instanceof Error ? error.message : String(error)) }
    finally { answerInFlight.current = false; setAnswerSending(false) }
  }, [activeRunId, composerText])

  const retry = useCallback(() => {
    const prompt = record?.prompt ?? projection.prompt ?? ''
    if (prompt) void submit(prompt)
  }, [projection.prompt, record?.prompt, submit])

  /**
   * Follow up: a new run that is a child of the one on screen (decision 8).
   *
   * `followUpTarget` is `null` for the whole pipeline and a stage id for "from <stage>", where the
   * earlier stages are **not** re-executed — their stored handovers are replayed. Unlike Retry,
   * this does not save the document first: the followed run's stages are replayed from the archive,
   * so pinning the new run to whatever is on disk now is the same trade every run already makes.
   */
  const followUp = useCallback(async () => {
    const prompt = composerText.trim()
    if (!prompt || !activeRunId || !doc.path || starting) return
    if (['dirty', 'new'].includes(doc.documentChipState)) {
      setPendingPrompt(prompt)
      const saved = await doc.save()
      setPendingPrompt(null)
      if (!saved) { setStartError('The team file could not be saved, so no follow-up was started.'); return }
    }
    await launch(prompt, null, doc.currentRevision(), {
      followsRunId: activeRunId,
      startAt: doc.mode === 'pipeline' ? followUpTarget : null,
    })
  }, [activeRunId, composerText, doc, followUpTarget, launch, starting])

  /**
   * "Start a new run from this checkpoint" — never "Resume".
   *
   * The label is the design's, verbatim and deliberately: nothing here reattaches to the stopped
   * run, nothing reconciles the side effects it had already caused, and a word that implied either
   * would be a promise the tree cannot keep. The prompt is the stopped run's own, so the operator
   * can press it without retyping the goal.
   */
  const startFromCheckpoint = useCallback(async (checkpointId: string) => {
    if (!doc.path || starting) return
    const prompt = (record?.prompt ?? projection.prompt ?? '').trim() || composerText.trim()
    if (!prompt) { setStartError('This run has no prompt to continue from. Type one first.'); return }
    await launch(prompt, null, doc.currentRevision(), { fromCheckpointId: checkpointId })
  }, [composerText, doc, launch, projection.prompt, record?.prompt, starting])

  // §3.4: `[ Reuse ]` on the failed response node copies the run's original prompt back
  // into the composer — the prompt survives on the Prompt node (§12.2), so this is a
  // missing route, not lost data.
  const reusePrompt = useCallback(() => {
    const prompt = record?.prompt ?? projection.prompt ?? ''
    if (!prompt) return
    setComposerText(prompt)
    document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus()
  }, [record?.prompt, projection.prompt])

  // §15.2.2: the permanent Prompt node is the composer seen in a second place, so clicking it
  // puts the caret in the one editor rather than opening another.
  const focusComposer = useCallback(() => {
    document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus()
  }, [])

  const closeRun = useCallback(() => {
    if (activeRunId) setLastOpenedRun({ id: activeRunId, path: doc.path })
    showRun(null)
  }, [activeRunId, doc.path, showRun])

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
  const agentIds = useMemo(() => doc.nodes.map((node) => node.id), [doc.nodes])
  // Planned capability wiring lives in a sidecar, never in the team file the daemon runs.
  const composerLayout = useComposerLayout(doc.path, agentIds, doc.saveState !== 'new')
  // `submit` is declared above this hook, so it reads the planned deliverable through a ref that is
  // kept current after each commit rather than written during render.
  useEffect(() => { outputPlanRef.current = composerLayout.output }, [composerLayout.output])
  // A skill is executable, so its wiring lives in the team file; tools and knowledge sources have
  // no delivery contract yet and stay planned intent in the sidecar. The canvas draws both the
  // same way, so the edges it renders are the union.
  const wiringEdges = useMemo(() => {
    const cardIdByName = new Map(
      composerLayout.nodes.filter((node) => node.kind === 'skill').map((node) => [node.name, node.id]),
    )
    const executable = doc.nodes.flatMap((node) =>
      (node.data.agent.capabilities ?? []).flatMap((capability) => {
        const to = cardIdByName.get(capability.name)
        return to ? [{ from: node.id, to }] : []
      }),
    )
    // Sidecar edges drawn before capabilities were executable keep rendering: dropping them would
    // silently erase wiring the operator can see on their canvas. They stay planned-only until the
    // edge is drawn again, which now writes it to the team file.
    const planned = composerLayout.edges.filter(
      (edge) => !executable.some((live) => live.from === edge.from && live.to === edge.to),
    )
    return [...planned, ...executable]
  }, [composerLayout.nodes, composerLayout.edges, doc.nodes])

  // ---- agent positions live in the sidecar (ADR 0016, CANVAS_SPEC §7.3 option A) -------------
  //
  // Hydrate once per document. The sidecar answers a moment after the YAML, so the cards are
  // briefly at the deterministic auto-layout and then settle where the operator left them. Gated
  // on `loadedFor`, which is null while the read is in flight *and* when it failed — a sidecar we
  // could not read must not be applied as an empty arrangement.
  //
  // One effect, not two, and no state: hydration and write-back are the same synchronisation, and
  // splitting them made the write-back miss the render hydration happened on.
  //
  // `doc.nodes` is the authority on where a card *is* — every position mutation goes through it
  // (a drag, `settleNodeCollision`, auto-layout, undo), which is why this mirrors the document
  // into the sidecar rather than the other way round. On the one pass that hydrates, the saved map
  // wins so the write-back does not immediately overwrite it with the seeded auto-layout.
  //
  // The sidecar's own 600 ms debounce collapses a drag into one write, and `setAgentPositions` is
  // a no-op when the map is unchanged, so running this on every render costs an object compare.
  const savePositions = composerLayout.setAgentPositions
  const hydrated = useRef<string | null>(null)
  useEffect(() => {
    if (!doc.path || composerLayout.loadedFor !== doc.path) return
    const first = hydrated.current !== doc.path
    const positions = Object.fromEntries(doc.nodes.map((node) =>
      [node.id, (first ? composerLayout.agents[node.id] : undefined) ?? node.position]))
    if (first) {
      hydrated.current = doc.path
      doc.applyPositions(composerLayout.agents)
    }
    savePositions(positions)
  }, [doc, composerLayout.loadedFor, composerLayout.agents, savePositions])

  // ---- memory cards: the union of the sidecar's and the team file's ---------------------------
  //
  // §7 of the memory design: a `memory.inherits` entry written by hand in the YAML shows as a card,
  // rather than being invisible until someone happens to drag the same Library row onto the canvas.
  // A synthetic card has no saved position, so it is placed by the same deterministic slot finder
  // click-placed cards use; drag it and the sidecar gains a real card at that position.
  const memoryCards = useMemo<CapabilityNodeConfig[]>(() => {
    const placed = new Set(composerLayout.nodes.map((node) => memoryKey(node.memory)).filter(Boolean))
    const taken = [...doc.nodes.map((node) => node.position), ...composerLayout.nodes.map((node) => node.position)]
    const anchor = doc.nodes[0]?.position ?? { x: 0, y: 0 }
    return doc.memoryInherits.flatMap((entry) => {
      const key = memoryKey(entry)
      if (!key || placed.has(key)) return []
      placed.add(key)
      const name = entry.team ?? entry.pack ?? ''
      const position = freeCapabilitySlot({ x: anchor.x, y: anchor.y + 240 }, taken)
      taken.push(position)
      return [{
        id: capabilityNodeId('knowledge', name),
        kind: 'knowledge' as const,
        name: entry.team ? `${entry.team} · memory` : name,
        source: entry.team ? 'LoomWatch' : 'imported',
        position,
        memory: { team: entry.team, pack: entry.pack },
      }]
    })
  }, [composerLayout.nodes, doc.memoryInherits, doc.nodes])
  const capabilityCards = useMemo(() => [...composerLayout.nodes, ...memoryCards], [composerLayout.nodes, memoryCards])
  // Taking a capability card off the canvas must also stop the daemon delivering it, or the team
  // file would keep a skill the operator can no longer see.
  const removeCapabilityCards = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    const going = capabilityCards.filter((node) => ids.includes(node.id))
    const names = new Set(going.filter((node) => node.kind === 'skill').map((node) => node.name))
    if (names.size > 0) {
      for (const node of doc.nodes) {
        const current = node.data.agent.capabilities ?? []
        const kept = current.filter((capability) => !names.has(capability.name))
        if (kept.length !== current.length) doc.setAgentCapabilities(node.id, kept)
      }
    }
    // Taking a memory card off the canvas must also stop the daemon supplying it, or the team file
    // would keep inheriting memory the operator can no longer see. The Markdown and the pack folder
    // on disk are untouched: this drops the reference, not the writing.
    for (const node of going) {
      if (node.memory?.team) doc.removeMemoryInherit({ team: node.memory.team })
      else if (node.memory?.pack) doc.removeMemoryInherit({ pack: node.memory.pack })
    }
    composerLayout.remove(ids)
  }, [capabilityCards, composerLayout, doc])

  /**
   * Edges into a memory card, read from `memory.inherits` — the team file, not the sidecar.
   *
   * `appliesTo: [reviewer]` is "Reviewer reads it"; the **absence** of `appliesTo` is "the whole
   * team reads it", which is drawn from the permanent Prompt node because the Prompt node is the
   * operator and the whole team is the operator's scope. Reading the edges off the contract rather
   * than off the sidecar is what makes a YAML edit and a drawn edge the same picture.
   */
  const memoryEdges = useMemo(() => {
    const cardFor = new Map(capabilityCards.flatMap((node) => {
      const key = memoryKey(node.memory)
      return key ? [[key, node.id] as const] : []
    }))
    return doc.memoryInherits.flatMap((entry) => {
      const to = cardFor.get(memoryKey(entry))
      if (!to) return []
      const scoped = entry.appliesTo ?? []
      return scoped.length > 0
        ? scoped.map((agentId) => ({ from: agentId, to }))
        : [{ from: '__prompt', to }]
    })
  }, [capabilityCards, doc.memoryInherits])
  const allWiringEdges = useMemo(() => {
    const memory = memoryEdges.filter((edge) => !wiringEdges.some((live) => live.from === edge.from && live.to === edge.to))
    return [...wiringEdges, ...memory]
  }, [wiringEdges, memoryEdges])
  const capabilityEdgeById = useMemo(
    () => new Map(allWiringEdges.map((edge) => [capabilityEdgeId(edge.from, edge.to), edge])),
    [allWiringEdges],
  )

  /** Remove one relationship without removing the capability card or its other consumers. */
  const removeCapabilityEdge = useCallback((source: string, target: string) => {
    const capability = capabilityCards.find((node) => node.id === target)
    if (!capability) return

    if (capability.memory) {
      const key = capability.memory.team
        ? { team: capability.memory.team }
        : { pack: capability.memory.pack }
      const existing = doc.memoryInherits.find((entry) =>
        (key.team !== undefined && entry.team === key.team) || (key.pack !== undefined && entry.pack === key.pack))
      if (source === '__prompt' || !existing?.appliesTo) {
        doc.removeMemoryInherit(key)
      } else {
        const appliesTo = existing.appliesTo.filter((agentId) => agentId !== source)
        if (appliesTo.length > 0) doc.addMemoryInherit({ ...key, appliesTo })
        else doc.removeMemoryInherit(key)
      }
    } else if (capability.kind === 'skill') {
      const agent = doc.nodes.find((node) => node.id === source)?.data.agent
      const current = agent?.capabilities ?? []
      const kept = current.filter((entry) => entry.name !== capability.name)
      if (agent && kept.length !== current.length) doc.setAgentCapabilities(source, kept)
      // Pre-executable layouts may still contain the same skill edge in the sidecar.
      if (composerLayout.edges.some((edge) => edge.from === source && edge.to === target)) composerLayout.disconnect(source, target)
    } else {
      composerLayout.disconnect(source, target)
    }

    const id = capabilityEdgeId(source, target)
    setSelectedCapabilityEdgeIds((selected) => {
      if (!selected.has(id)) return selected
      const next = new Set(selected)
      next.delete(id)
      return next
    })
    const owner = source === '__prompt' ? 'The whole team' : nodeNames.get(source) ?? source
    setStatusAnnouncement(`${owner} no longer ${RELATION[capability.kind]} ${capability.name}.`)
  }, [capabilityCards, composerLayout, doc, nodeNames])

  const problems = useMemo(() => reviewProblems(doc.entrypointProblem, doc.fieldProblemsByAgent, doc.documentProblems, nodeNames), [doc.entrypointProblem, doc.fieldProblemsByAgent, doc.documentProblems, nodeNames])
  const scheduleProblems = useMemo(() => problems.filter((problem) => problem.yamlPath?.[0] === 'schedule'), [problems])
  const visibleSchedule = useMemo(() => doc.teamSchedule ?? (scheduleProblems.length > 0 ? { cron: '0 8 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: 'Run this team on schedule.', enabled: true } : null), [doc.teamSchedule, scheduleProblems.length])
  // "Save schedule" means: write the four editable fields into the document model, regenerate the
  // YAML, re-run validation — and only then close. Closing unconditionally (as it used to) hid the
  // case where a schedule problem outlives the save, leaving the operator staring at a red node and
  // a blocked composer with no explanation. The effect below reads the *re-validated* problems.
  const saveSchedule = useCallback((schedule: NonNullable<typeof visibleSchedule>) => {
    doc.updateTeamSchedule(schedule)
    setScheduleSaveAttempt((attempt) => attempt + 1)
  }, [doc])
  useEffect(() => {
    if (scheduleSaveAttempt === 0 || handledScheduleSaveRef.current === scheduleSaveAttempt) return
    handledScheduleSaveRef.current = scheduleSaveAttempt
    if (scheduleProblems.length > 0) {
      setStatusAnnouncement(`Schedule still needs attention: ${scheduleProblems[0].message}`)
      return
    }
    setScheduleSaved(true)
    setStatusAnnouncement('Schedule updated. Save the team file to finish.')
  }, [scheduleSaveAttempt, scheduleProblems])
  const showScheduleYaml = useCallback(() => {
    setScheduleEditorOpen(false)
    setYamlHighlightLine(yamlLineForPath(doc.yamlPreview, ['schedule']))
    setYamlOpen(true)
  }, [doc.yamlPreview])
  const configuredPairs = useMemo(() => new Set(doc.edges.map((edge) => `${edge.source}->${edge.target}`)), [doc.edges])

  // A question travels back up a configured edge: the stage before this one stays alive precisely
  // so it can be asked, so `b asked a` where the file declares `a → b` is the design working, not a
  // delegation outside the graph. Any other pair still is.
  const anomalies = useMemo(() => (doc.mode === 'pipeline'
    ? projection.delegations.filter((delegation) => {
      if (configuredPairs.has(`${delegation.from}->${delegation.to}`)) return false
      return !(delegation.kind === 'ask' && configuredPairs.has(`${delegation.to}->${delegation.from}`))
    })
    : []), [doc.mode, projection.delegations, configuredPairs])

  /**
   * What this attempt follows, in the two words the design uses (§15.2.2).
   *
   * The **record** is preferred over the client-side retry `Map`: `followsRunId`/`retryOfRunId` are
   * server-side lineage and survive a page reload, which the `Map` does not. A run that is both a
   * follow-up and another attempt at the same job — "Start a new run from this checkpoint" — reads
   * as a follow-up, which is what it mechanically is.
   */
  const lineageLabel = useMemo(() => {
    if (!activeRunId) return null
    const attemptOf = (runId: string) => {
      const all = mergeHistory(history.records, history.sessions).map((entry) => entry.id).reverse()
      const index = all.indexOf(runId)
      return index >= 0 ? String(index + 1).padStart(2, '0') : runId.slice(0, 8)
    }
    if (record?.followsRunId) return `Follow-up of Run ${attemptOf(record.followsRunId)}`
    const retriedServerSide = record?.retryOfRunId
    const retried = retriedServerSide ?? retryOf.get(activeRunId)
    return retried ? `Retry of Run ${attemptOf(retried)}` : null
  }, [activeRunId, record, retryOf, history.records, history.sessions])

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
  // §15.2.6: helpers a run reveals that the document has no node for. They are placed by the
  // existing seeded auto-layout around the entrypoint, as view state — node positions are not
  // part of the team file at all, so there is nothing to offer saving them to (see the ledger).
  const entrypointPosition = useMemo(() => {
    const entry = doc.nodes.find((node) => node.id === (doc.entrypoint ?? leadId)) ?? doc.nodes[0]
    return entry?.position ?? null
  }, [doc.nodes, doc.entrypoint, leadId])
  const helperPlacements = useMemo(() => {
    if (!entrypointPosition) return {}
    const helpers = orderedAgentIds.filter((id) => !doc.nodes.some((node) => node.id === id))
    return helperPositions(helpers, entrypointPosition)
  }, [orderedAgentIds, doc.nodes, entrypointPosition])

  // CONTRACT §4: only the canonical responder's reply is the answer; other agents' messages
  // are evidence. The fallback exists solely for archived sessions whose team is unknown.
  const responderAgent = projection.agents.find((agent) => agent.id === responderId) ?? (responderId ? undefined : [...projection.agents].reverse().find((agent) => agent.reply))
  const responseText = session.cursor === null && record?.reply != null
    ? recordedReplyText(session.events, responderId, record.reply) : responderAgent?.reply ?? ''
  const phase: RunPhase = projection.phase
  const live = session.mode === 'live'
  const attempt = useMemo(() => {
    if (!activeRunId) return 1
    const all = mergeHistory(history.records, history.sessions).map((entry) => entry.id).reverse()
    const index = all.indexOf(activeRunId)
    return index >= 0 ? index + 1 : all.length + 1
  }, [activeRunId, history.records, history.sessions])
  const elapsed = formatElapsed(projection.startedAt ?? record?.startedAt ?? record?.createdAt ?? null, isTerminalRun(record?.status) || !live ? projection.updatedAt ?? record?.finishedAt ?? null : new Date().toISOString())

  /**
   * The stages a follow-up may start at, **in pipeline order**.
   *
   * Empty in team mode, which then offers only "whole pipeline": `edges: []` means there is no
   * configured order, so "from the third agent" is not something the file expresses — and the
   * daemon refuses it rather than guessing.
   */
  const followUpStages = useMemo(
    () => (doc.mode === 'pipeline'
      ? doc.pipelineSteps.map((step) => ({ id: step.id, name: nodeNames.get(step.id) ?? step.id }))
      : []),
    [doc.mode, doc.pipelineSteps, nodeNames],
  )

  /**
   * The newest checkpoint per agent, in the order the run reached them.
   *
   * `GET /api/runs/{id}/checkpoints` answers every row, and a stage that called the `checkpoint`
   * tool as well as reaching its boundary has more than one. The strip is about where the work
   * stopped, so it reads the last one each stage left.
   */
  const latestCheckpoints = useMemo(() => {
    const byAgent = new Map<string, Checkpoint>()
    for (const row of checkpoints?.rows ?? []) {
      const held = byAgent.get(row.agentId)
      if (!held || row.invocation >= held.invocation) byAgent.set(row.agentId, row)
    }
    return [...byAgent.values()]
  }, [checkpoints])

  // The agents this run stored a packet for, so an agent card can offer the packet inspector
  // even when it was handed nothing.
  const packetAgentIds = useMemo(
    () => new Set(packetAgents?.runId === activeRunId ? packetAgents.ids : []),
    [packetAgents, activeRunId],
  )
  /**
   * Notebook entries each agent was **supplied**, counted from its own stored packet.
   *
   * Not from the notes that exist: the notebook grows during a run, and what an agent was given
   * is what its packet recorded when its session opened. Counting live notes would make the chip
   * say "given 5 notes" to a stage that was given two.
   */
  const givenNotes = useMemo(
    () => (packetAgents?.runId === activeRunId ? packetAgents.notes : {}),
    [packetAgents, activeRunId],
  )

  /**
   * Replays are read-only stories, so they may use a clean presentation layout without moving the
   * saved Build canvas. Include observed handoffs as layout constraints and bridge an archived lead
   * into the current configured entrypoint when the team file has changed since the run. This is
   * exactly the case that previously stranded an old `collector` beneath the current pipeline.
   */
  const historicalPositions = useMemo(() => {
    if (!runView || session.mode !== 'replay') return null
    const agentIds = new Set(orderedAgentIds)
    const sequence = [
      ...doc.edges.map((edge) => ({ from: edge.source, to: edge.target })),
      ...projection.delegations.map((edge) => ({ from: edge.from, to: edge.to })),
    ].filter(({ from, to }) => agentIds.has(from) && agentIds.has(to) && from !== to)
    return historicalRunPositions(
      orderedAgentIds.map((id) => ({ id, ...synthMeasurements[id] })),
      sequence,
      capabilityCards.map((node) => ({ id: node.id, ...synthMeasurements[node.id] })),
      allWiringEdges,
      leadId,
      doc.entrypoint,
    )
  }, [runView, session.mode, orderedAgentIds, doc.edges, doc.entrypoint, projection.delegations, synthMeasurements, capabilityCards, allWiringEdges, leadId])

  // ---- one canvas — TNG89_INTERACTION.md §15 -------------------------------------------
  //
  //   > The configured graph never moves; a run is drawn onto it.
  //
  // One builder, not a compose branch and a run branch. The same agent cards sit at the same
  // `doc.nodes` positions in every state and gain runtime facts — status rail, live perimeter,
  // task, cost, event count, the packet route — when a run is shown. The Prompt and Output nodes
  // are permanent and docked to the ends of the configured graph, which is what guarantees rows
  // 23/24/42 (Prompt first, Output last) now that no column computes it.
  const graph = useMemo(() => {
    const nodes: AnyNode[] = []
    const edges: AnyEdge[] = []
    const addNode = (node: AnyNode) => {
      const measured = synthMeasurements[node.id]
      nodes.push(measured ? { ...node, measured } : node)
    }

    const docNodeById = new Map(doc.nodes.map((node) => [node.id, node]))
    // A replay's archived lead is the story's entrypoint even when the team file has changed.
    // Build and live views continue to use the current document as their source of truth.
    const entryId = historicalPositions ? leadId ?? doc.entrypoint ?? doc.nodes[0]?.id ?? null : doc.entrypoint ?? leadId ?? doc.nodes[0]?.id ?? null
    // Pipeline mode docks the Output right of the terminal stage; team mode has no configured
    // order, so the entrypoint — the only stage the file names — carries both anchors.
    const historicalMode = historicalPositions ? record?.mode ?? doc.mode : doc.mode
    const terminalId = historicalPositions
      ? responderId ?? (historicalMode === 'team' ? entryId : responderFromDoc)
      : doc.mode === 'pipeline'
        ? (responderId && docNodeById.has(responderId) ? responderId : responderFromDoc)
        : entryId
    const pointFor = (id: string | null | undefined) => id ? historicalPositions?.[id] ?? docNodeById.get(id)?.position ?? helperPlacements[id] : null
    const entryPoint = pointFor(entryId)
    const configuredTerminalPoint = pointFor(terminalId) ?? entryPoint
    // The responder can be any stage. Its output must still sit beyond the entire team,
    // rather than overlap a later card when the first agent owns the response.
    const storyPoints = historicalPositions
      ? orderedAgentIds.map((id) => historicalPositions[id]).filter((point): point is { x: number; y: number } => Boolean(point))
      : doc.nodes.map((node) => node.position)
    const terminalPoint = configuredTerminalPoint
      ? { ...configuredTerminalPoint, x: Math.max(configuredTerminalPoint.x, ...storyPoints.map((point) => point.x)) }
      : configuredTerminalPoint
    const docked = entryPoint ? dockAnchors(entryPoint, terminalPoint ?? entryPoint) : null
    const terminalName = terminalId ? nodeNames.get(terminalId) ?? terminalId : 'the last stage'

    // ---- the permanent Prompt node (§15.2.2), first in the DOM and in causal order -------
    if (docked) {
      const prompt: PromptNode = {
        id: '__prompt',
        type: 'prompt',
        position: overlayPositions.__prompt ?? docked.prompt,
        initialWidth: DOCK.promptW,
        initialHeight: DOCK.promptH,
        data: runView
          ? { text: (record?.prompt ?? projection.prompt ?? '') || '(prompt not archived)', attempt, runId: activeRunId ?? '', lineage: lineageLabel }
          // Before a run it mirrors the composer's draft and focuses it when clicked: one editor
          // seen in two places, never two editors.
          : { text: composerText, attempt: null, runId: '', draft: true },
        draggable: true,
        selectable: false,
        connectable: false,
      }
      addNode(prompt)
    }
    if (docked && runView) {
      const runId = activeRunId ?? ''
      const parent = retryOf.get(runId)
      const promptHeight = synthMeasurements.__prompt?.height ?? DOCK.promptH
      const runPosition = overlayPositions.__run ?? {
        ...docked.run,
        y: docked.prompt.y + Math.max(DOCK.runOffsetY, promptHeight + 32),
      }
      // §12.2 requires the attempt card to stay visible; §15 shrinks it into the Prompt's dock
      // column rather than giving it a column of its own.
      const run: RunNode = {
        id: '__run',
        type: 'run',
        position: runPosition,
        initialWidth: DOCK.runW,
        initialHeight: DOCK.runH,
        data: { attempt, phase, runId, mode: session.mode, branch: lineageLabel ?? (parent ? 'Retry of an earlier run' : 'Initiating branch'), elapsed, trigger: record?.trigger },
        draggable: true,
        selectable: false,
        connectable: false,
      }
      addNode(run)
      edges.push({ id: '__prompt->__run', source: '__prompt', target: '__run', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'starts', story: true }, selectable: false, focusable: false })
      const lead = leadId && (docNodeById.has(leadId) || helperPlacements[leadId]) ? leadId : entryId
      if (lead) edges.push({ id: '__run->lead', source: '__run', sourceHandle: 'lead', target: lead, type: 'prov', markerEnd: PROV_MARKER, data: { label: 'assigns lead', story: true }, selectable: false, focusable: false })
    } else if (docked && entryId) {
      // Before a run the same arrow names the same configured relationship: this prompt starts here.
      edges.push({ id: '__prompt->entry', source: '__prompt', target: entryId, type: 'prov', markerEnd: PROV_MARKER, data: { label: 'starts', story: true }, selectable: false, focusable: false, ariaLabel: `starts from your prompt to ${nodeNames.get(entryId) ?? entryId}` })
    }

    // ---- the schedule card keeps the dock column, above the Prompt -----------------------
    if (visibleSchedule && docked) {
      const scheduleNode: ScheduleNode = {
        id: '__schedule',
        type: 'schedule',
        position: docked.schedule,
        initialWidth: SCHEDULE_CARD.width,
        initialHeight: SCHEDULE_CARD.height,
        draggable: false,
        selectable: true,
        selected: scheduleEditorOpen,
        connectable: false,
        data: {
          schedule: visibleSchedule,
          invalid: scheduleProblems.length > 0,
          editorOpen: scheduleEditorOpen,
          onOpen: () => setScheduleEditorOpen(true),
        },
      }
      addNode(scheduleNode)
      if (entryId) edges.push({ id: '__schedule->entrypoint', source: '__schedule', target: entryId, type: 'warp', markerEnd: WARP_MARKER, selectable: false, focusable: false, ariaLabel: `schedule starts ${nodeNames.get(entryId) ?? entryId}` })
    }

    // ---- the agents, at the positions the operator arranged (§15.2.1) ---------------------
    const projectedById = new Map(projection.agents.map((agent) => [agent.id, agent]))
    const agentIdsInOrder = runView ? orderedAgentIds : doc.nodes.map((node) => node.id)
    agentIdsInOrder.forEach((id) => {
      const docNode = docNodeById.get(id)
      const position = historicalPositions?.[id] ?? docNode?.position ?? helperPlacements[id]
      if (!position) return
      const agent = docNode?.data.agent ?? syntheticAgent(id)
      const base: AgentNode = docNode ?? { id, type: 'agent', position, selected: false, data: { label: agent.name, agent } }
      const label = ownerLabels.get(id) ?? id
      const projected = projectedById.get(id)
      const costUsd = projected?.costUsd ?? null
      const eventCount = evidenceByAgent.get(id)?.length ?? 0
      const runtime = !runView
        ? undefined
        : projected
          ? { status: projected.status, taskState: projected.taskState, task: projected.task, ownerLabel: label, costUsd, spentPct: costUsd !== null && (agent.budget?.limitUsd ?? 0) > 0 ? (costUsd / (agent.budget?.limitUsd ?? 0)) * 100 : null, live: live && (projected.status === 'running' || projected.status === 'starting'), busUnavailable: projected.busUnavailable, received: projected.received, eventCount, openCalls: projected.openCalls, fanned: fannedAgentId === id, hasPacket: packetAgentIds.has(id), givenNotes: givenNotes[id] ?? 0 }
          : { status: 'idle' as AgentStatus, taskState: (phase === 'queued' || phase === 'starting' ? 'QUEUED' : 'READY') as TaskState, task: phase === 'queued' || phase === 'starting' ? 'Waiting for the run to start' : 'Awaiting a task', ownerLabel: label, costUsd: null, spentPct: null, live: false, eventCount, fanned: fannedAgentId === id, hasPacket: packetAgentIds.has(id), givenNotes: givenNotes[id] ?? 0 }
      if (runtime && session.cursor === null && waiting) {
        if (waiting.node === id) Object.assign(runtime, { status: 'waiting', taskState: 'WAITING', task: waiting.question, live: false })
        else if (waiting.handoverFrom === id) Object.assign(runtime, { status: 'succeeded', taskState: 'SUCCEEDED', task: 'Handover ready', live: false })
      }
      addNode({
        ...base,
        position,
        data: { ...base.data, label: agent.name, agent, isEntrypoint: id === (doc.entrypoint ?? leadId), fieldProblems: docNode?.data.fieldProblems, runtime, waiting: session.cursor === null && waiting?.node === id ? waiting : null, onAnswer: focusComposer },
        ariaLabel: runtime
          ? `${agent.name}, ${label}, ${runtime.taskState}, ${runtime.task}`
          : `${agent.name}, ${agent.role || 'no role'}, ${agent.model || 'no model'}, ${agent.status ?? 'idle'}`,
        ariaRole: 'button' as const,
      })
    })

    // ---- one agent's evidence, fanned beside it (§15.2.3) --------------------------------
    // Folded is the default: the count lives on the card, and only the agent the operator opened
    // renders cards, so React Flow draws the agents plus one cluster instead of every event.
    if (runView && fannedAgentId) {
      const anchor = historicalPositions?.[fannedAgentId] ?? docNodeById.get(fannedAgentId)?.position ?? helperPlacements[fannedAgentId]
      const ids = evidenceByAgent.get(fannedAgentId) ?? []
      if (anchor && ids.length > 0) {
        const fan = fanEvidence(anchor, ids)
        projection.evidence.forEach((item) => {
          if (item.agentId !== fannedAgentId) return
          // Evidence folded into the "+N more" card has no slot and no node; the panel lists it.
          const position = overlayPositions[item.id] ?? fan.shown[item.id]
          if (!position) return
          const isLive = live && (item.status === 'running' || item.status === 'pending')
          const evidenceNode: EvidenceNode = {
            id: item.id,
            type: 'evidence',
            position,
            initialWidth: DOCK.evidenceW,
            initialHeight: DOCK.evidenceH,
            draggable: true,
            connectable: false,
            data: { evidence: item, ownerLabel: ownerLabels.get(item.agentId) ?? item.agentId, live: isLive, selected: inspectedEvidenceId === item.id },
          }
          addNode(evidenceNode)
          edges.push({ id: `ev:${item.id}`, source: item.agentId, target: item.id, type: 'prov', markerEnd: isLive ? LIVE_MARKER : PROV_MARKER, data: { live: isLive }, selectable: false, focusable: false, ariaLabel: `${ownerLabels.get(item.agentId) ?? item.agentId} ${item.relation} ${item.name}` })
        })
        if (fan.more) {
          const moreNode: MoreNode = {
            id: `__more:${fannedAgentId}`,
            type: 'more',
            position: overlayPositions[`__more:${fannedAgentId}`] ?? fan.more,
            initialWidth: DOCK.evidenceW,
            initialHeight: DOCK.evidenceH,
            draggable: true,
            selectable: false,
            connectable: false,
            data: { agentId: fannedAgentId, ownerLabel: ownerLabels.get(fannedAgentId) ?? fannedAgentId, hidden: fan.more.hidden, total: ids.length },
          }
          addNode(moreNode)
          edges.push({ id: `more:${fannedAgentId}`, source: fannedAgentId, target: moreNode.id, type: 'prov', markerEnd: PROV_MARKER, data: {}, selectable: false, focusable: false })
        }
      }
    }

    // ---- configured sequence edges, in every state (the warp) ----------------------------
    const delegationCounts = new Map<string, number>()
    projection.delegations.forEach((delegation) => { const key = `${delegation.from}->${delegation.to}`; delegationCounts.set(key, (delegationCounts.get(key) ?? 0) + 1) })
    doc.edges.forEach((edge) => {
      const key = `${edge.source}->${edge.target}`
      const count = runView ? delegationCounts.get(key) ?? 0 : 0
      edges.push({ ...edge, type: 'warp', markerEnd: WARP_MARKER, data: { ...edge.data!, count: count || undefined, shuttle: count > 0 && live && projectedById.get(edge.target)?.status === 'running' }, ariaLabel: `sequence from ${nodeNames.get(edge.source) ?? edge.source} to ${nodeNames.get(edge.target) ?? edge.target}` })
    })

    // ---- observed delegations drawn on the configured graph (the weft) --------------------
    if (runView) {
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
    }

    // ---- planned capability wiring, in every state ----------------------------------------
    for (const capability of capabilityCards) {
      const wiredTo = allWiringEdges.filter((edge) => edge.to === capability.id).length
      const node: CapabilityNode = {
        id: capability.id,
        type: 'capability',
        position: historicalPositions?.[capability.id] ?? capability.position,
        initialWidth: CAPABILITY_CARD.width,
        initialHeight: CAPABILITY_CARD.height,
        draggable: editable,
        selectable: true,
        selected: selectedCapabilities.has(capability.id),
        data: { kind: capability.kind, name: capability.name, source: capability.source, wiredTo, readOnly: !editable, onRemove: () => removeCapabilityCards([capability.id]) },
      }
      addNode(node)
    }
    for (const edge of allWiringEdges) {
      const capability = capabilityCards.find((node) => node.id === edge.to)
      if (!capability) continue
      // A whole-team inherit is drawn from the Prompt node, which only exists once the graph has
      // an entrypoint to dock against; without it the edge would name a node that is not there.
      if (edge.from === '__prompt' && !docked) continue
      const owner = edge.from === '__prompt' ? 'the whole team' : nodeNames.get(edge.from) ?? edge.from
      const ownerPosition = historicalPositions?.[edge.from] ?? docNodeById.get(edge.from)?.position
      const capabilityPosition = historicalPositions?.[capability.id] ?? capability.position
      const resourceLane = ownerPosition && Math.abs(capabilityPosition.x - ownerPosition.x) < 48 && capabilityPosition.y > ownerPosition.y + 150
      const id = capabilityEdgeId(edge.from, edge.to)
      edges.push({
        id,
        source: edge.from,
        sourceHandle: resourceLane ? 'resources' : undefined,
        target: edge.to,
        type: 'prov',
        markerEnd: PLAN_MARKER,
        ariaLabel: `${owner} ${RELATION[capability.kind]} ${capability.name}`,
        data: {
          label: RELATION[capability.kind],
          story: false,
          resource: !runView || Boolean(resourceLane),
          onRemove: editable ? () => removeCapabilityEdge(edge.from, edge.to) : undefined,
          removeLabel: `Remove connection: ${owner} ${RELATION[capability.kind]} ${capability.name}`,
        },
        selected: selectedCapabilityEdgeIds.has(id),
        selectable: editable,
        deletable: editable,
        focusable: editable,
      })
    }

    // ---- the permanent Output node (§15.2.2), last in the DOM and in causal order ---------
    if (docked) {
      // The answer is credited by name alone: "Assigned to Writer", not "Writer · final answer".
      const responderLabel = responderAgent ? nodeNames.get(responderAgent.id) ?? responderAgent.id : responderId ? nodeNames.get(responderId) ?? responderId : 'the team'
      const producer = responderAgent?.id ?? responderId
      const producerName = (producer ? nodeNames.get(producer) : null) ?? terminalName
      // A follow-up "from Writer" runs Writer only, so the promise has to name the stage that will
      // actually reply — the *first executed* one when it is also the last, and the terminal stage
      // otherwise. Naming the terminal stage of a pipeline whose earlier stages are not running
      // would promise an answer from something that never starts.
      const firstExecutedName = record?.startAt ? nodeNames.get(record.startAt) ?? record.startAt : null
      if (!runView) {
        const output: OutputNode = {
          id: '__output',
          type: 'response',
          position: overlayPositions.__output ?? docked.output,
          initialWidth: DOCK.outputW,
          initialHeight: DOCK.outputH,
          draggable: true,
          selectable: false,
          connectable: editable && doc.mode === 'pipeline',
          // No attempt exists, so there is no phase word, no live/replay badge and no producer to
          // credit — only the configured promise of who will fill it.
          data: { text: '', phase: 'queued', phaseText: 'No run yet.', producer: terminalId, producerLabel: terminalName, mode: 'live', streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: false, configurable: editable && doc.mode === 'pipeline', awaiting: true, placeholder: `The team's answer appears here when ${terminalName} replies.` },
        }
        addNode(output)
        if (terminalId) edges.push({ id: '__responds', source: terminalId, target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'responds with', story: true }, selectable: false, focusable: false, ariaLabel: `responds with from ${terminalName} to the output` })
        return { nodes, edges }
      }
      const streaming = live && phase === 'running' && responderAgent?.taskState === 'STREAMING'
      const pending = phase === 'queued' || phase === 'starting'
      const runningCount = projection.agents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length
      const phaseText = waiting && session.cursor === null ? 'Waiting for your answer.' : phase === 'queued' ? 'Queued — waiting for a supervisor.'
        : phase === 'starting' ? `Starting ${nodeNames.get(leadId ?? '') ?? leadId ?? 'the lead'}…`
        : phase === 'running' ? (streaming ? `Streaming — ${responderLabel} responding.` : `Running — ${runningCount} agent${runningCount === 1 ? '' : 's'} active.`)
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
      // A placeholder is a promise, so it is only offered while the run can still keep it. A
      // terminal run with no answer gets the strip and `[ Reuse ]` instead (§3.4).
      const settled = phase === 'succeeded' || phase === 'partial' || phase === 'failed' || phase === 'cancelled'
      const output: OutputNode = {
        id: '__output',
        type: 'response',
        position: overlayPositions.__output ?? docked.output,
        initialWidth: DOCK.outputW,
        initialHeight: DOCK.outputH,
        draggable: true,
        selectable: false,
        connectable: false,
        data: { text: responseText, phase, phaseText, producer: responderAgent?.id ?? responderId ?? null, producerLabel: responderLabel, mode: session.mode, streaming, pending, strip, compact: provenanceOpen, expanded: provenanceOpen, terminal: session.terminal, placeholder: responseText || settled ? null : `The team's answer appears here when ${firstExecutedName && orderedAgentIds.length <= 1 ? firstExecutedName : producerName} replies.` },
      }
      addNode(output)
      if (producer && (docNodeById.has(producer) || helperPlacements[producer])) edges.push({ id: '__responds', source: producer, target: '__output', type: 'prov', markerEnd: PROV_MARKER, data: { label: 'responds with', story: true }, selectable: false, focusable: false })
      edges.push({ id: '__completes', source: '__run', target: '__output', targetHandle: 'run', type: 'prov', markerEnd: PROV_MARKER, data: { label: `Run ${String(attempt).padStart(2, '0')} · completes as`, story: true, arc: true }, selectable: false, focusable: false })
    }
    return { nodes, edges }
  }, [runView, doc.nodes, doc.edges, doc.mode, doc.entrypoint, nodeNames, projection, record, activeRunId, attempt, retryOf, phase, session.mode, session.error, session.lastSeq, session.terminal, elapsed, orderedAgentIds, ownerLabels, evidenceByAgent, leadId, live, configuredPairs, overlayPositions, synthMeasurements, inspectedEvidenceId, responderAgent, responderId, responderFromDoc, responseText, provenanceOpen, visibleSchedule, scheduleProblems.length, scheduleEditorOpen, capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, composerText, fannedAgentId, helperPlacements, historicalPositions, packetAgentIds, givenNotes, lineageLabel, waiting, focusComposer, session.cursor, removeCapabilityEdge, removeCapabilityCards])

  // Both surfaces draw the same agent card, so both name the harness that card runs in — a run
  // that cannot resolve one says so rather than falling back to the generic word. The Prompt node
  // and the configured output name belong to Build alone: a run has an attempt to show instead of
  // a draft, and an answer to read instead of a promise.
  const canvasNodes = useMemo(() => {
    const named = graph.nodes.map((node) => node.type === 'agent'
      ? { ...node, data: { ...node.data, harnessLabel: appLabelForAgent((node as AgentNode).data.agent, harnesses) } }
      : node)
    if (runView) return named
    return named
      .filter((node) => node.id !== '__prompt' || allWiringEdges.some((edge) => edge.from === '__prompt'))
      .map((node) => node.type === 'response' ? { ...node, data: { ...node.data, outputName: composerLayout.output?.name, outputFormat: composerLayout.output?.format } } : node)
  }, [graph.nodes, harnesses, runView, allWiringEdges, composerLayout.output])

  const observedCount = projection.delegations.length
  // UX_REDESIGN §6.7: solo is conditional chrome — the legend is its only readout and click-path
  // back, so the cycle control may act only while the legend is on screen. Observed (weft) edges
  // are a run-view projection, so the predicate is run-view only; a solo left over from a run
  // (e.g. a replay scrubbed past the delegations) suspends instead of silently blanking edges.
  const layersVisible = runView && observedCount > 0
  const soloActive: LayerSolo = layersVisible ? solo : 'both'
  const visibleEdges = useMemo(() => graph.edges.filter((edge) => soloActive === 'both' || (soloActive === 'configured' ? edge.type !== 'weft' : edge.type !== 'warp')), [graph.edges, soloActive])

  const [layoutRevision, setLayoutRevision] = useState(0)
  const arrangementKey = `${doc.path}:${doc.nodes.map((node) => node.id).join(',')}:${capabilityCards.map((node) => node.id).join(',')}`
  const [previousArrangement, setPreviousArrangement] = useState<{ key: string; agents: Positions; resources: CapabilityNodeConfig[]; overlays: Positions } | null>(null)
  const canOrganize = editable && doc.nodes.length > 0 && (!doc.path || composerLayout.loadedFor === doc.path)
  const organize = useCallback(() => {
    if (!canOrganize) return
    const positions = organizePipeline(
      doc.nodes.map((node) => ({ id: node.id, ...synthMeasurements[node.id] })),
      doc.edges.map((edge) => ({ from: edge.source, to: edge.target })),
      capabilityCards.map((node) => ({ id: node.id, ...synthMeasurements[node.id] })),
      allWiringEdges,
    )
    setPreviousArrangement({ key: arrangementKey, agents: Object.fromEntries(doc.nodes.map((node) => [node.id, node.position])), resources: capabilityCards, overlays: overlayPositions })
    const agents = Object.fromEntries(doc.nodes.map((node) => [node.id, positions[node.id]]))
    doc.applyPositions(agents)
    composerLayout.arrange(agents, capabilityCards.map((node) => ({ ...node, position: positions[node.id] ?? node.position })))
    setOverlayPositions({})
    setFannedAgentId(null)
    setLayoutRevision((revision) => revision + 1)
  }, [canOrganize, doc, synthMeasurements, capabilityCards, allWiringEdges, arrangementKey, overlayPositions, composerLayout])
  const undoOrganize = useCallback(() => {
    if (!canOrganize || previousArrangement?.key !== arrangementKey) return
    doc.applyPositions(previousArrangement.agents)
    composerLayout.arrange(previousArrangement.agents, previousArrangement.resources)
    setOverlayPositions(previousArrangement.overlays)
    setPreviousArrangement(null)
    setLayoutRevision((revision) => revision + 1)
  }, [canOrganize, previousArrangement, arrangementKey, doc, composerLayout])

  // ---- fit the visible workspace after a structural or viewport change -----------------
  // Opening or organizing a graph, loading its sidecar, and showing a terminal notice change
  // the available space. Fit those transitions, but never follow streamed tokens or replay
  // scrubbing: the camera must stay still while someone is reading.
  const fitKey = `${composerLayout.loadedFor}:${capabilityCards.length}:${session.terminal}:${latestCheckpoints.length}:${layoutRevision}:${doc.path ?? ''}:${doc.nodes.length}:${visibleSchedule ? 'scheduled' : 'manual'}:${activeRunId ?? 'design'}:${runView ? orderedAgentIds.length : 0}`
  const nodesInitialized = useNodesInitialized()
  const canvasRef = useRef<HTMLDivElement>(null)
  const pendingFit = useRef<string | null>(null)
  const lastFit = useRef('')
  // A Library toggle reframes too: the panel hides part of the canvas, so what "fits" changes.
  useEffect(() => {
    lastFit.current = fitKey
    pendingFit.current = fitKey
  }, [fitKey, libraryCollapsed, windowWidth, windowHeight])
  const fitCanvas = useCallback(() => {
    if (nodeDraggingRef.current) return
    const canvas = canvasRef.current
    const nodes = flow.getNodes()
    if (!canvas || nodes.length === 0) return
    const rect = canvas.getBoundingClientRect()
    const shell = canvas.closest('.lw-shell')
    const coveredLeft = !runView || windowWidth < 768 ? 0 : libraryCollapsed ? 68 : 344
    let bottom = rect.bottom - 24
    for (const selector of ['.lw-composer', '.lw-composer-notices']) {
      const panel = shell?.querySelector(selector)?.getBoundingClientRect()
      if (panel && panel.height > 0) bottom = Math.min(bottom, panel.top - 24)
    }
    const top = !runView ? 68 : windowWidth >= 768 && windowWidth < 1400 ? 184 : 132
    const bounds = getNodesBounds(nodes)
    const viewport = getViewportForBounds(bounds, Math.max(200, rect.width - coveredLeft - 24), Math.max(160, bottom - rect.top - top), runView ? 0.1 : 0.35, runView ? 1 : 1.5, runView ? 0.12 : 0.2)
    void flow.setViewport({ ...viewport, x: viewport.x + coveredLeft, y: viewport.y + top }, { duration: document.hidden ? 0 : 300 })
  }, [flow, windowWidth, libraryCollapsed, runView])
  useEffect(() => {
    // React Flow can only frame nodes it has measured; a fit requested while new cards are
    // still mounting waits for `useNodesInitialized` to flip back to true.
    if (!pendingFit.current || !nodesInitialized || nodeDragging) return
    pendingFit.current = null
    // Frame the story in the area the Library (or its rail) leaves visible, not the whole
    // canvas: computed directly from the measured bounds so nothing races React Flow's own
    // asynchronous fitView, and applied without animation in a hidden tab.
    // Timers rather than requestAnimationFrame: a run often finishes while the tab is in the
    // background, where animation frames are paused and the fit would never happen. Cards
    // that grow after mounting (streamed text, wrapped titles) shift the bounds once more, so
    // a settle pass keeps the whole story in frame without following every keystroke.
    const first = window.setTimeout(fitCanvas, 0)
    const settle = window.setTimeout(fitCanvas, 450)
    return () => { window.clearTimeout(first); window.clearTimeout(settle) }
  }, [fitKey, nodesInitialized, fitCanvas, nodeDragging, windowWidth, windowHeight])

  // ---- selection + changes -------------------------------------------------------------
  const recordMeasurements = useCallback((changes: readonly NodeChange[]) => {
    const dimensions = changes.filter((change) => change.type === 'dimensions' && change.dimensions)
    if (dimensions.length === 0) return
    setSynthMeasurements((current) => {
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
  }, [])

  // §15.2.1/§15.2.5: one handler, because there is one canvas. A change to a node the *document*
  // owns is the same edit whether or not a run is shown — including a drag, which moves the
  // design, because it *is* the design. Only the presentation nodes (the two docked anchors, the
  // Run card, fanned evidence) keep their positions in local view state.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Measurements are recorded for every id, unconditionally: filtering them by membership
    // read `composerLayout.nodes` from a closure that is one render stale for the card just
    // placed, so a brand-new capability lost its size and stayed hidden until something else
    // forced a re-render. The map is only ever *read* for nodes the document does not own.
    recordMeasurements(changes)
    // Capability cards belong to the sidecar, not to the team document: a position or a
    // removal there must never reach `TeamFileModel`, which only knows about agents.
    const isCapability = (id: string) => capabilityCards.some((node) => node.id === id)
    const isDocNode = (id: string) => doc.nodes.some((node) => node.id === id)

    if (changes.some((change) => change.type === 'select' && change.id === '__schedule' && change.selected)) setScheduleEditorOpen(true)
    // Both panels dock to the same right edge, so a node selection takes it back.
    else if (changes.some((change) => change.type === 'select' && change.selected)) setScheduleEditorOpen(false)
    if (changes.some((change) => change.type === 'select' && change.selected && isDocNode(change.id))) setInspectedCapability(null)

    for (const change of changes) {
      if (!('id' in change)) continue
      if (isCapability(change.id)) {
        // This is a controlled React Flow: feed every intermediate position back into the
        // sidecar state or the card is reconciled to its old position between pointer events.
        // The sidecar's debounce still collapses the gesture into one persisted write.
        if (change.type === 'position' && change.position) {
          // A card the sidecar does not have yet — one drawn from a `memory.inherits` entry — is
          // created at the position the drag settles on. Without this its position would be
          // recomputed from the slot finder on every render and the drag would be lost.
          const known = composerLayout.nodes.some((node) => node.id === change.id)
          if (known) composerLayout.move(change.id, change.position)
          else {
            const card = capabilityCards.find((node) => node.id === change.id)
            if (card) composerLayout.place({ kind: card.kind, name: card.name, source: card.source, memory: card.memory }, change.position)
          }
        }
        if (change.type === 'remove') removeCapabilityCards([change.id])
        if (change.type === 'select') {
          setSelectedCapabilities((current) => {
            const next = new Set(current)
            if (change.selected) next.add(change.id)
            else next.delete(change.id)
            return next
          })
          if (change.selected) {
            const capability = capabilityCards.find((node) => node.id === change.id)
            if (capability) {
              const inventory = capability.kind === 'skill' ? capabilityInventory.skills : capability.kind === 'tool' ? capabilityInventory.tools : capabilityInventory.sources
              const item = inventory.find((candidate) => candidate.name === capability.name && candidate.source === capability.source)
                ?? { id: capability.id, name: capability.name, source: capability.source, detail: 'Planned capability on this canvas.', status: 'Compatible' as const }
              setInspectedCapability({ item, kind: capability.kind })
              setInspectedEvidenceId(null)
              setProvenanceOpen(false)
            }
          } else {
            setInspectedCapability((current) => current && change.id === `${current.kind}:${current.item.name.trim().toLowerCase().replace(/\s+/g, '-')}` ? null : current)
          }
        }
        continue
      }
      if (isDocNode(change.id)) continue
      // Presentation nodes only from here: `__prompt`, `__run`, `__output`, evidence, `+N more`.
      if (change.type === 'position' && change.position) {
        const { id, position } = change
        setOverlayPositions((current) => (current[id]?.x === position.x && current[id]?.y === position.y ? current : { ...current, [id]: position }))
      }
      if (change.type === 'select' && change.selected && projection.evidence.some((item) => item.id === change.id)) setInspectedEvidenceId(change.id)
    }

    doc.onNodesChange(changes.filter((change) => !('id' in change) || isDocNode(change.id)) as NodeChange<AgentNode>[])
  }, [doc, projection.evidence, composerLayout, capabilityCards, capabilityInventory, recordMeasurements, removeCapabilityCards])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const documentChanges: EdgeChange[] = []
    for (const change of changes) {
      const capabilityEdge = 'id' in change ? capabilityEdgeById.get(change.id) : undefined
      if (!capabilityEdge) {
        documentChanges.push(change)
        continue
      }
      if (change.type === 'select') {
        setSelectedCapabilityEdgeIds((selected) => {
          const next = new Set(selected)
          if (change.selected) next.add(change.id)
          else next.delete(change.id)
          return next
        })
      } else if (change.type === 'remove') {
        removeCapabilityEdge(capabilityEdge.from, capabilityEdge.to)
      }
    }
    if (documentChanges.length > 0) doc.onEdgesChange(documentChanges as EdgeChange<never>[])
  }, [capabilityEdgeById, doc, removeCapabilityEdge])

  const clearSelection = useCallback(() => {
    doc.onNodesChange(doc.nodes.filter((node) => node.selected).map((node) => ({ id: node.id, type: 'select' as const, selected: false })))
    doc.onEdgesChange(doc.edges.filter((edge) => edge.selected).map((edge) => ({ id: edge.id, type: 'select' as const, selected: false })))
    setSelectedCapabilities(new Set())
    setSelectedCapabilityEdgeIds(new Set())
    setInspectedCapability(null)
    setInspectedEvidenceId(null)
  }, [doc])

  // A different file has a different schedule; its "saved" state is not this one's.
  if (schedulePath !== doc.path) {
    setSchedulePath(doc.path)
    setScheduleSaved(false)
    setScheduleEditorOpen(false)
  }

  // Opening the schedule takes the right edge from the Inspector; `onNodesChange` hands it back.
  useEffect(() => {
    if (scheduleEditorOpen && !scheduleWasOpenRef.current) clearSelection()
    scheduleWasOpenRef.current = scheduleEditorOpen
  }, [scheduleEditorOpen, clearSelection])

  const selectedNodes = doc.nodes.filter((node) => node.selected)
  const selectedEdges = doc.edges.filter((edge) => edge.selected)
  const selectedDocNode = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : null
  const inspectedNode = selectedDocNode
    ? ((runView ? graph.nodes.find((node) => node.id === selectedDocNode.id && node.type === 'agent') : undefined) as AgentNode | undefined) ?? selectedDocNode
    : null
  const inspectedHarnessId = inspectedNode ? harnessIdForAgent(inspectedNode.data.agent, harnesses) : null
  useEffect(() => {
    if (!inspectedHarnessId) return
    let cancelled = false
    const cached = modelCatalogCache.current.get(inspectedHarnessId)
    if (cached) {
      void Promise.resolve().then(() => {
        if (!cancelled) setModelCatalog({ harnessId: inspectedHarnessId, ...cached })
      })
      return () => { cancelled = true }
    }
    void fetchHarnessModels(inspectedHarnessId).then(
      (catalog) => {
        const result = { models: catalog.models, currentModelId: catalog.currentModelId, currentThinkingEffort: catalog.currentThinkingEffort, error: null }
        modelCatalogCache.current.set(inspectedHarnessId, result)
        if (!cancelled) setModelCatalog({ harnessId: inspectedHarnessId, ...result })
      },
      // Only a catalog that was actually read is cached. Discovery spawns the harness over ACP,
      // and an `npx`-launched adapter can blow the daemon's discovery budget on a cold start and
      // answer in a couple of seconds on the next attempt — caching that would strand the agent
      // on an empty model list for the rest of the session, reselecting the node included.
      (caught: unknown) => {
        const result = { models: [], currentModelId: undefined, currentThinkingEffort: undefined, error: caught instanceof Error ? caught.message : String(caught) }
        if (!cancelled) setModelCatalog({ harnessId: inspectedHarnessId, ...result })
      },
    )
    return () => { cancelled = true }
  }, [inspectedHarnessId, modelCatalogRetry])
  // A newly placed agent has no model, and an empty model blocks the run behind a "Required" field
  // the operator did not know to look for. Once this harness's catalog is in hand, adopt the model
  // the harness itself would use — its current model — so the agent can run as soon as it is placed.
  const inspectedAgentId = inspectedNode?.id ?? null
  const inspectedAgentNeedsModel = Boolean(inspectedNode && inspectedNode.data.agent.kind !== 'operator' && !inspectedNode.data.agent.model)
  const { updateAgentModel } = doc
  useEffect(() => {
    if (!editable || !inspectedAgentId || !inspectedAgentNeedsModel) return
    if (modelCatalog.harnessId !== inspectedHarnessId || modelCatalog.error) return
    const model = modelCatalog.currentModelId ?? modelCatalog.models[0]?.id
    if (model) updateAgentModel(inspectedAgentId, model)
  }, [editable, inspectedAgentId, inspectedAgentNeedsModel, inspectedHarnessId, modelCatalog, updateAgentModel])
  const inspectedModels = modelCatalog.harnessId === inspectedHarnessId ? modelCatalog.models : []
  const inspectedDefaultThinkingEffort = modelCatalog.harnessId === inspectedHarnessId ? modelCatalog.currentThinkingEffort : undefined
  const inspectedModelsError = modelCatalog.harnessId === inspectedHarnessId ? modelCatalog.error : null
  const inspectedModelsLoading = Boolean(inspectedHarnessId && modelCatalog.harnessId !== inspectedHarnessId)
  const inspectedEvidence: Evidence | null = inspectedEvidenceId ? projection.evidence.find((item) => item.id === inspectedEvidenceId) ?? null : null
  // Who handed it over: the stage before this one in causal order, which is what the daemon
  // concatenated into this agent's first prompt.
  // The panel opens for whichever agent was asked about, handover or not: it is the packet
  // inspector, and an entry point that was handed nothing still has a packet. Requiring
  // `received` here is what left that packet unreachable (docs/TEAM_MEMORY.md, known gaps).
  const handover = useMemo(() => {
    if (!handoverAgentId) return null
    const text = projection.agents.find((agent) => agent.id === handoverAgentId)?.received ?? ''
    const index = orderedAgentIds.indexOf(handoverAgentId)
    const previous = index > 0 ? orderedAgentIds[index - 1] : null
    return {
      text,
      toLabel: nodeNames.get(handoverAgentId) ?? handoverAgentId,
      fromLabel: previous ? nodeNames.get(previous) ?? previous : 'the preceding stage',
    }
  }, [handoverAgentId, projection.agents, orderedAgentIds, nodeNames])
  // The team's Brief, read over REST. Re-read when the document's path changes, when the operator
  // saves (the block may have gained an entry), and on demand. Memory deliberately does not ride
  // the WebSocket: docs/WEBSOCKET_SCHEMA.md is frozen, and the panel is read carefully rather
  // than watched, so a REST read on open is the honest shape.
  // One state object rather than three, and every write happens in a promise callback: the read
  // is keyed by the team path it answered, so "loading" is derived during render instead of being
  // set synchronously inside the effect.
  const [memoryRead, setMemoryRead] = useState<{ path: string; view: MemoryView | null; error: string | null } | null>(null)
  const [memoryGeneration, setMemoryGeneration] = useState(0)
  const memoryFresh = memoryRead?.path === doc.path
  const memory = memoryFresh ? memoryRead.view : null
  const memoryError = memoryFresh ? memoryRead.error : null
  const memoryLoading = Boolean(doc.path) && !memoryFresh
  useEffect(() => {
    const path = doc.path
    if (!path) return
    let cancelled = false
    fetchMemory(path)
      .then((view) => { if (!cancelled) setMemoryRead({ path, view, error: null }) })
      .catch((caught: unknown) => {
        if (!cancelled) setMemoryRead({ path, view: null, error: caught instanceof Error ? caught.message : String(caught) })
      })
    return () => { cancelled = true }
    // `documentChipState` going to `saved` is the signal that the block on disk may have changed.
  }, [doc.path, doc.documentChipState, memoryGeneration])

  // The stored packet for whichever agent's "what it was given" panel is open. One fetch per
  // agent: the packet is immutable once written, so there is nothing to poll.
  const [packet, setPacket] = useState<{ agentId: string; packet: ContextPacket | null; error: string | null } | null>(null)
  const packetFresh = packet?.agentId === handoverAgentId
  const packetLoading = Boolean(handoverAgentId && activeRunId) && !packetFresh
  useEffect(() => {
    const agentId = handoverAgentId
    if (!agentId || !activeRunId) return
    let cancelled = false
    fetchRunContext(activeRunId, agentId)
      .then((packets) => { if (!cancelled) setPacket({ agentId, packet: packets[0] ?? null, error: null }) })
      .catch((caught: unknown) => {
        if (!cancelled) setPacket({ agentId, packet: null, error: caught instanceof Error ? caught.message : String(caught) })
      })
    return () => { cancelled = true }
  }, [handoverAgentId, activeRunId])

  // Which agents this run stored a packet for. One read per run — packets are written before the
  // prompt is sent and are immutable — so an agent card can offer the inspector even when it was
  // handed nothing. Without it the entrypoint's packet was unreachable from the canvas.
  // Every write happens in a promise callback, and staleness is derived from the run id the read
  // answered for — the same shape as the Brief read above, and the reason no state is cleared
  // synchronously here.
  useEffect(() => {
    const runId = activeRunId
    if (!runId) return
    let cancelled = false
    fetchRunContext(runId)
      .then((packets) => {
        if (cancelled) return
        const notes: Record<string, number> = {}
        for (const entry of packets) {
          const supplied = entry.sections
            .filter((section) => section.kind === 'notebook')
            .reduce((sum, section) => sum + (section.notes?.length ?? 0), 0)
          notes[entry.agentId] = (notes[entry.agentId] ?? 0) + supplied
        }
        setPacketAgents({ runId, ids: [...new Set(packets.map((entry) => entry.agentId))], notes })
      })
      // A run that stored no packets and a read that failed are both "no route offered": the
      // panel is the place that reports a packet problem, and it only opens with an agent in hand.
      .catch(() => { if (!cancelled) setPacketAgents({ runId, ids: [], notes: {} }) })
    return () => { cancelled = true }
  }, [activeRunId])

  // The Notebook, read over REST beside the Brief.
  //
  // Re-read on three signals and no others: the team path changed, the operator acted on a note,
  // and — while a run is shown — the number of `memory_write` calls the run stream has delivered
  // changed. That last one is the invalidation hint: the count comes from the evidence projection
  // the stream already produces, so a note an agent writes mid-run appears in the panel without a
  // single new WebSocket message.
  const memoryWrites = useMemo(
    () => projection.evidence.filter(isNotebookWrite).length,
    [projection.evidence],
  )
  const notesFresh = notesRead?.path === doc.path
  const notes = notesFresh ? notesRead.view : null
  const notesError = notesFresh ? notesRead.error : null
  const notesLoading = Boolean(doc.path) && !notesFresh
  useEffect(() => {
    const path = doc.path
    if (!path) return
    let cancelled = false
    fetchNotes(path)
      .then((view) => { if (!cancelled) setNotesRead({ path, view, error: null }) })
      .catch((caught: unknown) => {
        if (!cancelled) setNotesRead({ path, view: null, error: caught instanceof Error ? caught.message : String(caught) })
      })
    return () => { cancelled = true }
  }, [doc.path, notesGeneration, memoryWrites])

  const applyNoteRevision = useCallback(async (
    id: string,
    action: 'keep' | 'correct' | 'retire',
    change: { revision: number; title?: string; body?: string },
  ) => {
    if (!doc.path) throw new Error('Open a team first.')
    await reviseNote(doc.path, id, action, change)
    setNotesGeneration((generation) => generation + 1)
  }, [doc.path])
  const readNoteHistory = useCallback(
    async (id: string): Promise<Note[]> => (doc.path ? fetchNoteHistory(doc.path, id) : []),
    [doc.path],
  )
  const writePack = useCallback(async () => {
    if (!doc.path) throw new Error('Open a team first.')
    const result = await exportPack(doc.path)
    return result.pack
  }, [doc.path])

  /**
   * Notes this run wrote that are still `active` — eligible, and not yet kept.
   *
   * The strip counts these and nothing else. A note the operator already kept is not "new", and a
   * note from another run is not this run's to promote.
   */
  const reviewableNotes = useMemo(
    () => (activeRunId ? (notes?.notes ?? []).filter((note) => note.runId === activeRunId && note.state === 'active') : []),
    [notes, activeRunId],
  )
  const keepAllNotes = useCallback(async () => {
    const path = doc.path
    if (!path) throw new Error('Open a team first.')
    // One at a time, in order: each Keep is a new revision, so a batch that raced itself would
    // lose one to the `UNIQUE (note_key, revision)` check for no reason.
    for (const note of reviewableNotes) {
      await reviseNote(path, note.id, 'keep', { revision: note.revision })
    }
    setNotesGeneration((generation) => generation + 1)
    if (activeRunId) setReviewed((seen) => new Set(seen).add(activeRunId))
  }, [reviewableNotes, doc.path, activeRunId])

  const addBriefFile = useCallback(async (file: string) => {
    doc.addBriefEntry({ path: file })
    setMemoryGeneration((generation) => generation + 1)
  }, [doc, setMemoryGeneration])
  const writeBriefNote = useCallback(async (body: string) => {
    if (!doc.path) throw new Error('Open a team first.')
    const file = briefFileNameFor(body, memory?.entries.map((entry) => entry.path) ?? [])
    // The file first, then the team-file entry: an entry pointing at a file that does not exist
    // would refuse the next run, which is a worse failure than a stray unreferenced Markdown file.
    await writeMemoryFile(doc.path, file, body.endsWith('\n') ? body : `${body}\n`)
    await addBriefFile(file)
  }, [doc.path, memory, addBriefFile])
  const removeBriefEntry = useCallback((path: string) => {
    doc.removeBriefEntry(path)
    setMemoryGeneration((generation) => generation + 1)
  }, [doc, setMemoryGeneration])
  /**
   * Rewrite one Brief entry in place.
   *
   * The team file already names this path, so this is only a file write — and it is the edit that
   * can land mid-run. The whole Brief is read once, at run acceptance, so an edit during a run
   * reaches the *next* session start and nothing that is already running; the strip says so, with
   * both times, and never claims a live turn was interrupted.
   */
  const editBriefNote = useCallback(async (file: string, body: string) => {
    if (!doc.path) throw new Error('Open a team first.')
    const title = memory?.entries.find((entry) => entry.path === file)?.title ?? file
    await writeMemoryFile(doc.path, file, body)
    setMemoryGeneration((generation) => generation + 1)
    if (activeRunId) setBriefEdit({ title, at: new Date() })
  }, [doc.path, memory, activeRunId, setMemoryGeneration, setBriefEdit])

  const scheduleOpen = Boolean(scheduleEditorOpen && visibleSchedule && !inspectedNode && !inspectedCapability)
  // The right dock holds one panel at a time, and every panel has to be in this condition or two
  // of them overlap. Memory yields to a selection the same way the schedule editor does.
  const memoryPanelOpen = Boolean(memoryOpen && !inspectedNode && !inspectedCapability && !inspectedEvidence && !handoverAgentId && !provenanceOpen && !scheduleOpen)
  /** Whether the deliverable, rather than the canvas, is the surface on screen. */
  const deliveryShown = (runView || runSetup) && runPresentation === 'delivery'
  const inspecting = Boolean(inspectedNode || inspectedCapability || inspectedEvidence || provenanceOpen || scheduleOpen || memoryPanelOpen)
  const inspectedCapabilityNode = inspectedCapability ? composerLayout.nodes.find((node) => node.kind === inspectedCapability.kind && node.name === inspectedCapability.item.name && node.source === inspectedCapability.item.source) ?? null : null
  const inspectedCapabilityAgents = inspectedCapability?.kind === 'skill'
    ? doc.nodes.filter((node) => (node.data.agent.capabilities ?? []).some((skill) => skill.name === inspectedCapability.item.name)).map((node) => node.data.agent.name)
    : inspectedCapabilityNode
    ? wiringEdges.filter((edge) => edge.to === inspectedCapabilityNode.id).map((edge) => nodeNames.get(edge.from) ?? edge.from)
    : []
  const inspectCapability = useCallback((item: DetectedCapability, kind: InspectedCapability['kind']) => {
    clearSelection()
    setScheduleEditorOpen(false)
    setProvenanceOpen(false)
    setInspectedCapability({ item, kind })
  }, [clearSelection])

  // §4's typed connection matrix. An agent may reach a capability (`uses skill` / `invokes` /

  // `reads`); every other pair is refused with a reason and changes nothing.
  const onConnect = useCallback((connection: { source: string | null; target: string | null }) => {
    const { source, target } = connection
    if (!source || !target) return
    if (target === '__output') {
      const agent = doc.nodes.find((node) => node.id === source)
      if (!agent) { setPlanRefusal('Only an agent can produce the team Output.'); return }
      if (doc.mode === 'team' && source !== doc.entrypoint) {
        setPlanRefusal('Create a pipeline to choose a responder other than the entrypoint.')
        return
      }
      doc.promoteResponder(source)
      setStatusAnnouncement(`${agent.data.label} now produces the team output.`)
      return
    }
    const targetCapability = capabilityCards.find((node) => node.id === target)
    const sourceCapability = capabilityCards.find((node) => node.id === source)
    if (!targetCapability && !sourceCapability) {
      doc.onConnect(connection as Parameters<typeof doc.onConnect>[0])
      return
    }
    // The Prompt node is the operator, and the operator's scope is the whole team — so a memory
    // card wired from it writes the whole-team form. Every other refusal rule still applies.
    const wholeTeam = source === '__prompt' && targetCapability?.memory !== undefined
    const refusal = wholeTeam ? null : refuseCapabilityEdge(
      { id: source, isAgent: !sourceCapability },
      { id: target, isAgent: !targetCapability, kind: targetCapability?.kind },
      allWiringEdges,
    )
    if (refusal) { setPlanRefusal(refusal); return }
    if (!targetCapability) { setPlanRefusal('A capability cannot start a connection. Drag from the agent that should use it.'); return }
    if (targetCapability.memory) {
      // Executable configuration in ADR 0012's sense: it changes what the daemon sends, so it goes
      // in the team file through the byte-preserving document model and the operator saves it.
      // `appliesTo: undefined` is written as the *absence* of the key rather than as a list of
      // today's agents, so a team that later gains an agent supplies it to that one too.
      const key = targetCapability.memory.team
        ? { team: targetCapability.memory.team }
        : { pack: targetCapability.memory.pack }
      const existing = doc.memoryInherits.find((entry) =>
        (key.team !== undefined && entry.team === key.team) || (key.pack !== undefined && entry.pack === key.pack))
      const appliesTo = wholeTeam
        ? undefined
        : [...new Set([...(existing?.appliesTo ?? []), source])]
      doc.addMemoryInherit({ ...key, appliesTo })
      setStatusAnnouncement(wholeTeam
        ? `The whole team reads ${targetCapability.name}.`
        : `${nodeNames.get(source) ?? source} reads ${targetCapability.name}.`)
      return
    }
    if (targetCapability.kind === 'skill') {
      const agent = doc.nodes.find((node) => node.id === source)?.data.agent
      if (!agent) return
      // Skill provenance and execution harness are independent. The daemon copies the selected
      // Agent Skills bundle into this agent's harness-native project directory before the run.
      const already = agent.capabilities ?? []
      if (!already.some((capability) => capability.name === targetCapability.name)) {
        doc.setAgentCapabilities(source, [...already, { kind: 'skill', name: targetCapability.name }])
      }
    } else {
      composerLayout.connect(source, target)
    }
    setStatusAnnouncement(`${nodeNames.get(source) ?? source} ${RELATION[targetCapability.kind]} ${targetCapability.name}.`)
  }, [capabilityCards, allWiringEdges, composerLayout, doc, nodeNames])
  useEffect(() => {
    if (!planRefusal) return
    const timer = setTimeout(() => setPlanRefusal(null), 4000)
    return () => clearTimeout(timer)
  }, [planRefusal])

  useEffect(() => {
    const refused = (event: Event) => setPlanRefusal((event as CustomEvent<string>).detail)
    window.addEventListener('loomwatch:placement-refused', refused)
    return () => window.removeEventListener('loomwatch:placement-refused', refused)
  }, [])

  const deleteNodes = useCallback((ids: readonly string[]) => {
    const capabilities = ids.filter((id) => capabilityCards.some((node) => node.id === id))
    if (capabilities.length > 0) removeCapabilityCards(capabilities)
    const agents = ids.filter((id) => !capabilities.includes(id))
    if (agents.length > 0) doc.onNodesChange(agents.map((id) => ({ id, type: 'remove' as const })))
  }, [doc, capabilityCards, removeCapabilityCards])
  const requestNodeDelete = useCallback((ids: readonly string[]) => {
    if (!editable || ids.length === 0) return
    if (doc.edges.some((edge) => ids.includes(edge.source) || ids.includes(edge.target))) { setPendingNodeDelete([...ids]); return }
    deleteNodes(ids)
  }, [doc.edges, editable, deleteNodes])

  const selectProblem = useCallback((problem: ReviewProblem) => {
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
  }, [doc, flow])
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
  // A capability is planned intent, not an agent: it lands in the sidecar layout, and the team
  // YAML the daemon runs is untouched (TNG-122 §8.2).
  const placeCapability = useCallback((raw: string, position: { x: number; y: number }, ontoPrompt = false) => {
    let payload: CapabilityDragPayload
    try {
      payload = JSON.parse(raw) as CapabilityDragPayload
    } catch {
      return
    }
    if (!payload?.kind || !payload.name) return
    // Click- and keyboard-placed cards all arrive at the viewport centre; without this the second
    // one lands exactly on the first. Dropped cards get the same nudge when the spot is taken.
    const taken = [...doc.nodes.map((node) => node.position), ...capabilityCards.map((node) => node.position)]
    const id = composerLayout.place(payload, freeCapabilitySlot({ x: snapToGrid(position.x), y: snapToGrid(position.y) }, taken))
    // Dropping a memory card on the **Prompt node** is the whole-team gesture: the Prompt node is
    // the operator, and the operator's scope is every agent. It writes the same `memory.inherits`
    // entry that wiring the card from the Prompt node writes, with no `appliesTo`.
    if (ontoPrompt && payload.memory) {
      const key = payload.memory.team ? { team: payload.memory.team } : { pack: payload.memory.pack }
      doc.addMemoryInherit({ ...key, appliesTo: undefined })
      setStatusAnnouncement(`The whole team reads ${payload.name}.`)
      return id
    }
    setStatusAnnouncement(`${payload.name} placed on the canvas. Connect an agent to it to say the agent ${RELATION[payload.kind]} it.`)
    return id
  }, [capabilityCards, composerLayout, doc])

  /** Whether a flow-space point lands on the permanent Prompt node's card. */
  const overPromptNode = useCallback((point: { x: number; y: number }) => {
    const prompt = flow.getNode('__prompt')
    if (!prompt) return false
    const width = prompt.measured?.width ?? DOCK.promptW
    const height = prompt.measured?.height ?? DOCK.promptH
    return point.x >= prompt.position.x && point.x <= prompt.position.x + width
      && point.y >= prompt.position.y && point.y <= prompt.position.y + height
  }, [flow])
  useEffect(() => {
    // §15.2.5: a run no longer has to be closed first — a placement during a run is a normal
    // edit, and the run on screen keeps executing the revision it was started against.
    const add = (event: Event) => {
      if (!editable || !doc.path) return
      placeCapability((event as CustomEvent<string>).detail, flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
    }
    window.addEventListener('loomwatch:add-capability', add)
    return () => window.removeEventListener('loomwatch:add-capability', add)
  }, [editable, doc.path, placeCapability, flow])

  const onDragOver = useCallback((event: React.DragEvent) => {
    const plannedSource = event.dataTransfer.types.includes(LIBRARY_DRAG_MIME) || event.dataTransfer.types.includes(CAPABILITY_DRAG_MIME)
    const evidenceSource = event.dataTransfer.types.includes(EVIDENCE_DRAG_MIME)
    if (!(plannedSource && editable) && !(evidenceSource && runView)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = evidenceSource ? 'move' : 'copy'
  }, [editable, runView])
  const onDrop = useCallback((event: React.DragEvent) => {
    setLibraryDragging(false)
    const evidenceId = runView ? event.dataTransfer.getData(EVIDENCE_DRAG_MIME) : ''
    if (evidenceId) {
      const item = projection.evidence.find((candidate) => candidate.id === evidenceId)
      if (!item) return
      event.preventDefault()
      // Dropping an evidence card onto the canvas fans its agent, or the card would have no
      // node to land on — the fold is the default and only one agent is ever open.
      setFannedAgentId(item.agentId)
      setOverlayPositions((current) => ({ ...current, [evidenceId]: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) }))
      setInspectedEvidenceId(evidenceId)
      return
    }
    if (!editable) return
    const capability = event.dataTransfer.getData(CAPABILITY_DRAG_MIME)
    if (capability) {
      event.preventDefault()
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      placeCapability(capability, at, overPromptNode(at))
      return
    }
    const raw = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
    if (!raw) return
    event.preventDefault()
    doc.addAgentFromDrop(raw, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [doc, flow, editable, runView, projection.evidence, placeCapability, overPromptNode])

  const onNodeDragStart = useCallback<OnNodeDrag<AnyNode>>(() => {
    nodeDraggingRef.current = true
    setNodeDragging(true)
    doc.capturePositionHistory()
  }, [doc])
  const onNodeDragStop = useCallback<OnNodeDrag<AnyNode>>((_event, node) => {
    nodeDraggingRef.current = false
    setNodeDragging(false)
    doc.settleNodeCollision(node.id, node.position)
  }, [doc])
  useEffect(() => {
    const add = (event: Event) => {
      if (!editable || !doc.path) return
      doc.addAgentFromDrop((event as CustomEvent<string>).detail, flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
    }
    window.addEventListener('loomwatch:add-agent', add)
    return () => window.removeEventListener('loomwatch:add-agent', add)
  }, [doc, editable, flow])

  // ---- notifications + announcements -----------------------------------------------------
  const waitingAlert: Attention | null = useMemo(() => waiting ? { id: `waiting:${waiting.questionId ?? waiting.since}`, seq: session.lastSeq, agentId: waiting.node, message: waiting.question } : null, [waiting, session.lastSeq])
  const alerts: Attention[] = [...session.latest.attention, ...(waitingAlert ? [waitingAlert] : [])].filter((alert) => !dismissedAlerts.has(alert.id))
  /**
   * Where an alert is *repaired*, which is not where it was raised: a run is a record, so the
   * only thing an operator can change is the team that produced it. Returns the agent and the
   * field in Build that would stop this happening again, or null when nothing in the team file
   * would — a crash, a stop reason and an escalation are not configuration mistakes.
   */
  const fixForAlert = useCallback((alert: Attention): { agentId: string; field: AgentField; hint: string } | null => {
    const evidence = alert.evidenceId ? projection.evidence.find((item) => item.id === alert.evidenceId) : undefined
    // A delegation to an agent this team does not have: the caller's instructions named a
    // teammate that does not exist, so the instructions are the thing to change.
    if (evidence?.kind === 'delegation' && evidence.target && !doc.nodes.some((node) => node.id === evidence.target || node.data.agent.name === evidence.target)) {
      const roster = doc.nodes.map((node) => node.data.agent.name).filter(Boolean)
      return { agentId: alert.agentId, field: 'role', hint: `These instructions ask for “${evidence.target}”, which is not on this team. This team has: ${roster.join(', ')}.` }
    }
    if (/^Budget warning for /.test(alert.message) && doc.nodes.some((node) => node.id === alert.agentId)) {
      return { agentId: alert.agentId, field: 'limitUsd', hint: 'This agent reached its budget warning threshold.' }
    }
    return null
  }, [projection.evidence, doc.nodes])

  // Build is the only editing surface, so "fix it" leaves the run, selects the agent, opens its
  // full settings and puts the cursor in the field that has to change.
  const fixAttention = useCallback((alert: Attention) => {
    const fix = fixForAlert(alert)
    if (!fix) return
    setInspectedEvidenceId(null)
    setRunPresentation('delivery')
    closeRun()
    doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === fix.agentId })))
    setForcedInspectorField({ agentId: fix.agentId, field: fix.field, hint: fix.hint })
    problemFieldRef.current = { agentId: fix.agentId, field: fix.field }
    setProblemFocusRequest((request) => request + 1)
  }, [fixForAlert, closeRun, doc])

  /**
   * The note is wayfinding, not validation: it says why the operator was sent to this field, and
   * nothing here can check that new prose names a real teammate. So it retires when it has done
   * its job — the first edit to the field it pointed at — rather than pretending to re-verify.
   */
  const retireFixHint = useCallback((agentId: string, field: AgentField) => {
    setForcedInspectorField((current) => current && current.agentId === agentId && current.field === field ? null : current)
  }, [])

  // "Go to what raised this." An alert that names a recorded call opens that call; one that does
  // not — a crash, a budget warning, a stop reason — can still name its agent, so both surfaces
  // move to the stage that owns it. Trace frames the node on the canvas; Delivery opens the
  // stage, whose skills and tools panel is already scoped to it.
  const [attentionFocusAgentId, setAttentionFocusAgentId] = useState<string | null>(null)
  const revealAttention = useCallback((alert: Attention) => {
    const evidence = alert.evidenceId ? projection.evidence.find((item) => item.id === alert.evidenceId) : undefined
    if (evidence) {
      setFannedAgentId(evidence.agentId)
      setInspectedEvidenceId(evidence.id)
    } else {
      setInspectedEvidenceId(null)
    }
    if (runPresentation === 'trace') {
      doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === alert.agentId })))
      const target = graph.nodes.find((node) => node.id === evidence?.id) ?? graph.nodes.find((node) => node.id === alert.agentId)
      if (target) void flow.fitView({ nodes: [target], padding: 0.8, maxZoom: 1, duration: 300 })
    } else {
      // Delivery is a reading surface: move the lane, and leave the node Inspector closed.
      setAttentionFocusAgentId(alert.agentId)
    }
  }, [projection.evidence, runPresentation, doc, graph.nodes, flow])
  const notifiedThrough = useRef(-1)
  useEffect(() => {
    if (!notificationsOn || !activeRunId) return
    for (const alert of [...session.latest.attention, ...(waitingAlert ? [waitingAlert] : [])]) {
      if (alert.seq > notifiedThrough.current) {
        try { new Notification(`LoomWatch · ${alert.agentId}`, { body: alert.message, tag: `${activeRunId}:${alert.id}` }) } catch { /* permission may be revoked */ }
      }
    }
    notifiedThrough.current = session.lastSeq
  }, [session.latest.attention, session.lastSeq, notificationsOn, activeRunId, waitingAlert])
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
    if (waiting) return { kind: 'answering', waiting, sending: answerSending }
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
  }, [waiting, answerSending, history.unavailable, runView, session.terminal, record, phase, starting, pendingPrompt, doc, problems.length, terminals, terminalIds, nodeNames, filename, flow])

  // ---- commands + keys ----------------------------------------------------------------------
  // With a team open the dialog belongs to the workspace; on Home, Home owns it.
  const openNewTeam = useCallback(() => { if (doc.path) setNewTeamSheet(true); else window.dispatchEvent(new Event('loomwatch:new-team')) }, [doc.path])
  const toggleLibrary = useCallback(() => window.dispatchEvent(new Event('loomwatch:toggle-library')), [])
  const actions = useMemo<CommandAction[]>(() => [
    // §1.2: the palette advertises ⌘↵, so it must do what ⌘↵ does. With nothing typed there is
    // no goal to run yet, and focusing the field is the honest half of the promise.
    { label: 'Run the team…', shortcut: '⌘↵', run: () => { if (composerText.trim()) void submit(); else document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus() }, disabled: !doc.path },
    { label: 'Run history', run: () => setHistoryOpen(true) },
    ...(runView ? [{ label: 'Clear the run', shortcut: 'Esc', run: closeRun }] : []),
    { label: 'Add agent…', run: toggleLibrary, disabled: !doc.path || !editable },
    { label: 'Save', shortcut: '⌘S', run: () => void doc.save(), disabled: !doc.path || !editable || !doc.isValid },
    { label: 'Open team…', run: () => setOpenPathOpen(true) },
    { label: 'New team…', shortcut: '⌘N', run: openNewTeam },
    { label: 'Reload from disk', run: () => void doc.reloadFromDisk(), disabled: !doc.path || doc.saveState === 'new' },
    { label: 'Discard changes', run: () => setDiscardConfirm(true), disabled: !doc.path || !['dirty', 'invalid', 'conflict'].includes(doc.documentChipState) },
    { label: 'Next problem', shortcut: 'F8', run: () => cycleProblem(1), disabled: problems.length === 0 },
    { label: 'Fit view', shortcut: 'F', run: fitCanvas },
    { label: 'Organize pipeline', shortcut: '⌥⌘L', run: organize, disabled: !canOrganize },
    { label: 'Toggle library', shortcut: '⌘\\', run: toggleLibrary, disabled: !doc.path || windowWidth < 768 },
    ...(layersVisible ? [{ label: 'Solo edge layer', shortcut: 'L', run: () => setSolo((current) => (current === 'both' ? 'configured' : current === 'configured' ? 'observed' : 'both')) }] : []),
    { label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', shortcut: '⌘⇧L', run: () => setThemeMode(theme === 'dark' ? 'light' : 'dark') },
    { label: 'Follow system appearance', run: () => setThemeMode('system') },
    { label: notificationsOn ? 'Disable notifications' : 'Enable notifications', run: () => void enableNotifications() },
    { label: 'Copy file path', run: () => { if (doc.path) void navigator.clipboard?.writeText(doc.path) }, disabled: !doc.path },
    { label: 'Show YAML', run: () => setYamlOpen(true), disabled: !doc.path },
    { label: 'Connections…', run: () => window.location.assign('/connections') },
  ], [doc, editable, composerText, submit, openNewTeam, toggleLibrary, windowWidth, runView, closeRun, cycleProblem, problems.length, theme, notificationsOn, enableNotifications, layersVisible, fitCanvas, organize, canOrganize])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      const editingText = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)
      if (mod && key === 'k') { event.preventDefault(); setPaletteOpen(true); return }
      if (mod && key === 's') { event.preventDefault(); if (editable) void doc.save(); return }
      if (mod && event.shiftKey && key === 'l') { event.preventDefault(); setSweeping(true); window.setTimeout(() => setSweeping(false), 340); setThemeMode(theme === 'dark' ? 'light' : 'dark'); return }
      if (mod && key === 'n') { event.preventDefault(); openNewTeam(); return }
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
        else if (handoverAgentId) setHandoverAgentId(null)
        else if (inspectedCapability) clearSelection()
        else if (provenanceOpen) setProvenanceOpen(false)
        else if (memoryOpen) setMemoryOpen(false)
        // §6.1: Esc unwinds the deepest disclosure. A fan is one, and folding it is not the same
        // as clearing the run — that is the last step in the chain, and only once it is terminal.
        else if (fannedAgentId) setFannedAgentId(null)
        else if (selectedNodes.length > 0 || selectedEdges.length > 0 || selectedCapabilityEdgeIds.size > 0) clearSelection()
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
      if (event.altKey && mod && key === 'l') { event.preventDefault(); organize(); return }
      if (layersVisible && key === 'l' && !mod && !event.altKey) { event.preventDefault(); setSolo((current) => (current === 'both' ? 'configured' : current === 'configured' ? 'observed' : 'both')); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && editable) {
        const selectedNodeIds = doc.nodes.filter((node) => node.selected).map((node) => node.id)
        const selectedEdgeIds = doc.edges.filter((edge) => edge.selected).map((edge) => edge.id)
        const selectedCapabilityEdges = [...selectedCapabilityEdgeIds]
        // Removing a capability card takes no confirmation: it deletes planned intent in a
        // sidecar, never an agent or anything the daemon runs.
        const capabilities = capabilityCards.filter((node) => selectedCapabilities.has(node.id)).map((node) => node.id)
        if (capabilities.length > 0) removeCapabilityCards(capabilities)
        if (selectedNodeIds.length > 0) requestNodeDelete(selectedNodeIds)
        else if (capabilities.length === 0 && selectedCapabilityEdges.length > 0) {
          for (const id of selectedCapabilityEdges) {
            const edge = capabilityEdgeById.get(id)
            if (edge) removeCapabilityEdge(edge.from, edge.to)
          }
        } else if (capabilities.length === 0 && selectedEdgeIds.length > 0) doc.onEdgesChange(selectedEdgeIds.map((id) => ({ id, type: 'remove' as const })))
        return
      }
      if (runView && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && session.lastSeq > 0) {
        event.preventDefault()
        const position = session.cursor === null ? session.lastSeq : session.cursor
        session.setCursor(event.key === 'ArrowLeft' ? Math.max(0, position - 1) : position + 1)
        return
      }
      // Tab walks the agents only while the canvas itself has focus; everywhere else it must keep
      // moving focus between controls, or keyboard users are trapped on the canvas.
      if (event.key === 'Tab' && doc.nodes.length > 0 && !runView && event.target instanceof HTMLElement && event.target.closest('.lw-canvas')) {
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
        if (selected && editable) window.dispatchEvent(new CustomEvent('loomwatch:rename-agent', { detail: { id: selected.id } }))
        return
      }
      if (key === 'f' && !mod) {
        event.preventDefault()
        const selected = doc.nodes.filter((node) => node.selected)
        if (event.shiftKey && selected.length > 0) void flow.fitView({ nodes: selected, padding: 0.2, maxZoom: 1, duration: 300 })
        else fitCanvas()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doc, editable, flow, submit, openNewTeam, toggleLibrary, paletteOpen, yamlOpen, compareOpen, windowWidth, clearSelection, discardConfirm, pendingNodeDelete, requestNodeDelete, deleteNodes, historyOpen, modeOpen, problemsOpen, inspectedEvidenceId, handoverAgentId, inspectedCapability, provenanceOpen, memoryOpen, selectedNodes.length, selectedEdges.length, selectedCapabilityEdgeIds, runView, session, closeRun, theme, cycleProblem, layersVisible, composerLayout, capabilityCards, selectedCapabilities, fannedAgentId, organize, fitCanvas, capabilityEdgeById, removeCapabilityEdge, removeCapabilityCards])

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
    editable, renameAgent: doc.renameAgent, touchField: doc.touchField, mode: doc.mode, stepById, nodeNames,
    inspectEvidence: (id) => { setInspectedEvidenceId(id); if (id) { doc.onNodesChange(doc.nodes.filter((node) => node.selected).map((node) => ({ id: node.id, type: 'select' as const, selected: false }))) } },
    inspectHandover: (id) => { setHandoverAgentId(id); setInspectedEvidenceId(null) },
    toggleProvenance: () => setProvenanceOpen((open) => !open),
    reusePrompt,
    focusComposer,
    // §15.2.3: one agent at a time. Opening another folds the first, which is the whole point —
    // the provenance panel, not a second fan, is where the full list lives.
    toggleEvidenceFan: (agentId) => setFannedAgentId((current) => (current === agentId ? null : agentId)),
    briefCount: memory?.entries.length ?? 0,
    teamDeliverAs: memory?.deliverAs,
    notebookEnabled: memory?.notebookEnabled ?? false,
  }), [editable, doc, stepById, nodeNames, reusePrompt, focusComposer, memory])

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

  // Who still holds the revision this run read: the agent that is running now if there is one,
  // otherwise the stage that will answer. Every agent in a run is supplied the same bytes, read
  // once at acceptance, so naming one is naming the revision, not guessing at a session's state.
  const briefHolderName = useMemo(() => {
    if (!runView) return null
    const id = projection.agents.find((agent) => agent.status === 'running' || agent.status === 'starting')?.id ?? responderId ?? leadId
    return id ? nodeNames.get(id) ?? id : null
  }, [runView, projection.agents, responderId, leadId, nodeNames])
  const briefSuppliedAt = useMemo(() => {
    const at = projection.startedAt ?? record?.startedAt ?? record?.createdAt ?? null
    return at ? new Date(at) : null
  }, [projection.startedAt, record?.startedAt, record?.createdAt])

  // Lineage as a thread: follow-ups indented under the run they follow, retries labelled as today.
  const historyEntries = useMemo(() => threadHistory(mergeHistory(history.records, history.sessions)), [history.records, history.sessions])
  const leadAgent = projection.agents.find((agent) => agent.id === leadId)
  const lifecycleResult = phase === 'queued' || phase === 'starting' ? 'not started' : phase === 'running' ? (responseText ? 'streaming' : 'pending') : phase === 'succeeded' ? 'done' : phase
  const loadedYaml = doc.loadedYaml ?? ''
  const differ = doc.documentChipState === 'dirty' ? linesDiffer(loadedYaml, doc.yamlPreview) : 0
  // The Build heading says what to do next, not what the screen is called.
  const setupHeading = doc.nodes.length === 0
    ? { title: 'Add your first agent', detail: 'Click + next to an AI app on the left. You can add more agents and connect them later.' }
    : !doc.isValid && !doc.checking
      ? { title: 'Finish setting up', detail: 'Open the list at the top to see what still needs your attention.' }
      : { title: 'Your team is ready', detail: 'Press Run team and describe what you want done. Add agents and connect them to hand work along.' }

  // §9.5: a failed load has no canvas to return to — the only modal.
  if (doc.loadFailure) return <ParseFailureModal failure={doc.loadFailure} path={doc.path} />

  // A `?path=` link is still loading: say so, rather than flashing the Home screen first.
  const requestedPath = new URLSearchParams(window.location.search).get('path')
  if (!doc.path && requestedPath && doc.saveState === 'no-file') {
    return <div className="lw-home lw-opening" role="status"><div className="ground" aria-hidden="true" /><p>Opening team…</p></div>
  }

  if (!doc.path) {
    return (
      <Home
        notice={requestedPath && doc.saveState === 'error' ? `Couldn't open “${requestedPath}”. ${/no such file|not found/i.test(doc.saveError ?? '') ? 'It may have been moved, renamed or deleted — pick a team below.' : doc.saveError ?? ''}` : null}
        harnesses={harnesses}
        harnessesLoading={harnessesLoading}
        harnessesError={harnessesError}
        onRetryHarnesses={onRetryHarnesses}
        onCreateBlank={(name, path) => { doc.createNewDocument(name, path); onDocumentOpen() }}
        onPalette={() => setPaletteOpen(true)}
      >
        {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
        {openPathOpen && <OpenTeamSheet onClose={() => setOpenPathOpen(false)} />}
      </Home>
    )
  }

  const WorkspaceResourceInspector = runView ? CapabilityInspector : BuildResourceInspector
  const WorkspaceInspector = runView ? Inspector : BuildInspector
  const WorkspaceLibrary = runView ? Library : ComponentPalette
  const shellClass = [
    // `build-graph` is the canvas's own presentation — card and edge anatomy, handles, backdrop —
    // and both surfaces that draw the graph set it. `build-workspace` is Build's page layout alone.
    'lw-shell', !runView && !runSetup ? 'build-workspace' : '', runPresentation === 'trace' || (!runView && !runSetup) ? 'build-graph' : '', `mode-${doc.mode}`, libraryDragging ? 'dragging' : '', nodeDragging ? 'node-dragging' : '', inspecting ? 'inspecting' : '', sweeping ? 'sweeping' : '',
    soloActive === 'configured' ? 'solo-configured' : soloActive === 'observed' ? 'solo-observed' : '', runView ? 'run-shown' : '', deliveryShown ? 'delivery-shown' : '',
    !runView || windowWidth >= 768 ? (libraryCollapsed ? 'lib-collapsed' : 'lib-open') : 'lib-hidden',
  ].filter(Boolean).join(' ')

  return (
    <CanvasActionsContext.Provider value={canvasActions}>
      <div className={shellClass} onDragEnter={(event) => { if (event.dataTransfer.types.includes(LIBRARY_DRAG_MIME) || event.dataTransfer.types.includes(EVIDENCE_DRAG_MIME)) setLibraryDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setLibraryDragging(false) }}>
        {deliveryShown ? (
          <DeliveryLane
            key={activeRunId ?? 'new-run'}
            planned={runSetup}
            onHistory={() => setHistoryOpen(true)}
            harnessLabels={new Map(doc.nodes.map((node) => [node.id, appLabelForAgent(node.data.agent, harnesses)]))}
            pipeline={(record?.mode ?? doc.mode) === 'pipeline'}
            linearPipeline={doc.edges.length === doc.nodes.length - 1 && doc.nodes.every((node) => doc.edges.filter((edge) => edge.source === node.id).length <= 1 && doc.edges.filter((edge) => edge.target === node.id).length <= 1)}
            onTrace={() => { if (runSetup) closeRun(); else setRunPresentation('trace') }}
            prompt={record?.prompt ?? projection.prompt ?? composerText} attempt={attempt} phase={phase} branch={retryOf.get(activeRunId ?? '') ? 'Retry of an earlier run' : 'Initiating branch'} elapsed={elapsed} mode={session.mode}
            agents={graph.nodes.filter((node): node is AgentNode => node.type === 'agent').sort((a, b) => runSetup ? (stepById.get(a.id)?.step ?? Infinity) - (stepById.get(b.id)?.step ?? Infinity) : 0)}
            evidenceByAgent={new Map(orderedAgentIds.map((id) => [id, projection.evidence.filter((item) => item.agentId === id)]))}
            ownerLabels={ownerLabels}
            output={(graph.nodes.find((node) => node.id === '__output') as OutputNode | undefined)?.data ?? { text: responseText, phase, phaseText: '', producer: null, producerLabel: 'the responder', mode: session.mode, streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: session.terminal }}
            projection={projection}
            selectedEvidenceId={inspectedEvidenceId}
            focusAgentId={attentionFocusAgentId}
            onInspectEvidence={(id) => setInspectedEvidenceId(id)}
            onSelectAgent={(id) => doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === id })))}
          />
        ) : (
        <div ref={canvasRef} role="application" aria-label={runView ? 'Run graph' : 'Team canvas'} className="lw-canvas">
          <ReactFlow
            nodes={canvasNodes}
            edges={runView ? visibleEdges : visibleEdges.filter(edge => edge.source !== '__prompt' || allWiringEdges.some(wire => wire.from === '__prompt'))}
            nodeTypes={runView ? nodeTypes : buildNodeTypes}
            edgeTypes={runView ? edgeTypes : buildEdgeTypes}
            onNodeClick={(_, node) => { if (!runView) { setOutputEditorOpen(node.id === '__output'); if (node.id === '__output') clearSelection() } }}
            onPaneClick={() => setOutputEditorOpen(false)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={editable ? onConnect : undefined}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            deleteKeyCode={null}
            nodesDraggable={editable || runView}
            nodesConnectable={editable}
            edgesReconnectable={editable}
            nodesFocusable
            edgesFocusable
            snapToGrid
            snapGrid={[12, 12]}
            minZoom={runView ? 0.1 : 0.35}
            maxZoom={runView ? 2 : 1.5}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            colorMode={theme}
          >
            <Background variant={'dots' as never} gap={24} size={1} color="var(--color-ground-dot)" />
            {doc.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="ghost t-body"><span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span>Add your first agent: click + next to an AI app on the left, or drag it here.</span><span className="t-meta">The first agent receives your request.</span></span></div>
              </div>
            )}
          </ReactFlow>
          {!runView && <><div className="build-canvas-help"><strong>Connect your agents</strong><span>Drag from the dot on the right of a card to the next card to hand work along.</span></div><div className="build-canvas-legend"><span><i />Workflow</span><span><i className="resource" />Resources</span><span>Select a node to edit</span></div></>}
        </div>
        )}
        <div className="lw-sweep" aria-hidden="true" />
        {!runView && !runSetup && <header className="build-workspace-heading"><div><h1>{setupHeading.title}</h1><span>{doc.saveState === 'new' ? 'Not saved yet' : ['dirty', 'conflict', 'error'].includes(doc.saveState) ? 'Unsaved changes' : 'Saved'}</span><p>{setupHeading.detail}</p></div><div className="build-workspace-actions"><button className="btn" disabled={!['dirty', 'new'].includes(doc.documentChipState) || !doc.isValid} onClick={() => void doc.save()}>Save</button><button className="btn btn-primary" onClick={() => { setRunSetup(true); setRunPresentation('delivery') }}><Play size={15} />Run team</button></div></header>}

        <div aria-live="polite" aria-atomic="true" className="visually-hidden">{politeAnnouncement}</div>
        <div aria-live="assertive" className="visually-hidden">{assertiveAnnouncement}</div>

        <div className="bar-stack">
          {doc.externalChange && <ConflictBar filename={filename} onKeepMine={doc.keepMine} onUseDisk={() => void doc.useDisk()} onCompare={() => setCompareOpen(true)} />}
          {doc.readOnlyReason && !doc.fileGone && <div role="status" className="bar halt"><ChipDot state="readonly" /><span className="msg t-body-m">{doc.readOnlyReason}</span><span className="sub t-meta">Read-only. Pan and inspect still work.</span></div>}
          {harnessesError && !runView && <div role="status" className="bar halt"><ChipDot state="failed" /><span className="msg t-body-m">LoomWatch can't reach the daemon.</span><span className="sub t-mono-sm">{harnessesError}</span><span className="acts"><button type="button" className="btn" onClick={onRetryHarnesses}>Retry now</button></span></div>}
          {startError && <div role="alert" className="bar alert"><ChipDot state="failed" /><span className="msg t-body-m">{startError}</span><span className="acts"><button type="button" className="btn" onClick={() => setStartError(null)}>Dismiss</button></span></div>}
        </div>

        {(!runView && !runSetup || runPresentation === 'trace') && (
          <WorkspaceLibrary harnesses={harnesses} harnessSearchPath={harnessSearchPath} knownHarnessIds={knownHarnessIds} harnessesLoading={harnessesLoading} harnessesError={harnessesError} onRetry={onRetryHarnesses} capabilityInventory={capabilityInventory} capabilitiesLoading={capabilitiesLoading} capabilitiesError={capabilitiesError} capabilitiesScannedAt={capabilitiesScannedAt} onRetryCapabilities={() => { onRetryCapabilities(); onRetryHarnesses() }} onInspectCapability={inspectCapability} onDragStateChange={setLibraryDragging} onCollapsedChange={setLibraryCollapsed} evidenceMode={runView} observedEvidence={runView ? projection.evidence : []} onRevealEvidence={(id) => {
            // Folded is the default, so "reveal" means: fan the agent that owns this card, then
            // frame it. Framing the agent rather than the card is deliberate — the evidence node
            // does not exist yet on this render.
            const item = projection.evidence.find((candidate) => candidate.id === id)
            if (item) setFannedAgentId(item.agentId)
            const target = graph.nodes.find((node) => node.id === id) ?? graph.nodes.find((node) => node.id === item?.agentId)
            if (target) void flow.fitView({ nodes: [target], padding: 0.8, maxZoom: 1, duration: 300 })
            setInspectedEvidenceId(id)
          }} />
        )}

        <div className="workspace-chrome pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-2" style={{ top: 'var(--lw-panel-inset)' }}>
          {/* The brand is the way home: every team is one click from the list of all teams. */}
          <a className="delivery-brand" href="/" aria-label="LoomWatch — all teams" style={{ pointerEvents: 'auto', color: 'inherit', textDecoration: 'none' }}>LoomWatch</a>
          <div className="prototype-workspace-menu"><button aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu(!workspaceMenu)}><MenuIcon size={15} aria-hidden="true" /></button>{workspaceMenu && <div role="menu"><button role="menuitem" onClick={() => { setWorkspaceMenu(false); window.location.assign('/') }}>All teams</button><button role="menuitem" onClick={() => { setWorkspaceMenu(false); setHistoryOpen(true) }}>Run history</button><button role="menuitem" onClick={() => { setWorkspaceMenu(false); clearSelection(); setMemoryOpen(true) }}>Team memory</button><button role="menuitem" onClick={() => { setWorkspaceMenu(false); setModeOpen(true) }}>Run settings</button><button role="menuitem" onClick={() => { setWorkspaceMenu(false); window.location.assign('/connections') }}>Connections…</button><button role="menuitem" disabled={!canOrganize} onClick={() => { setWorkspaceMenu(false); organize() }}>Organize</button>{previousArrangement && <button role="menuitem" onClick={() => { setWorkspaceMenu(false); undoOrganize() }}>Undo organize</button>}{runView && <button role="menuitem" onClick={() => { setWorkspaceMenu(false); setRunPresentation('trace') }}>Full trace</button>}<button role="menuitem" onClick={() => { setWorkspaceMenu(false); setYamlOpen(true) }}>View as YAML (advanced)</button></div>}</div>
          <nav className="workspace-view-tabs" aria-label="Workspace view">
            <button type="button" aria-pressed={runView || runSetup} onClick={() => { clearSelection(); if (activeRunId) setRunPresentation('delivery'); else if (lastOpenedRun?.path === doc.path) showRun(lastOpenedRun.id); else { setRunSetup(true); setRunPresentation('delivery') } }}><Play size={15} />Run</button>
            <button type="button" aria-pressed={!runView && !runSetup} onClick={() => { clearSelection(); closeRun() }}><Wrench size={15} />Build</button>
            {runView && runPresentation === 'trace' && <button type="button" className="trace-back" onClick={() => setRunPresentation('delivery')}>Back to output</button>}
          </nav>
          <DocumentSwitcher
            path={doc.path} teamName={doc.teamName} saveState={doc.documentChipState} saveError={doc.saveError} linesDiffer={differ}
            entrypointProblem={doc.entrypointProblem} documentProblems={doc.documentProblems} fieldProblemsByAgent={doc.fieldProblemsByAgent} agentNames={nodeNames}
            isValid={doc.isValid} readOnlyReason={doc.readOnlyReason} fileGone={doc.fileGone} editingDisabled={windowWidth < 768}
            onSave={() => void doc.save()} onSaveCopy={() => setSaveCopyOpen(true)} onReload={() => void doc.reloadFromDisk()} onDiscard={() => void doc.reloadFromDisk()} onShowYaml={() => setYamlOpen(true)}
            onNewTeam={openNewTeam} onSelectProblem={selectProblem} problemsOpen={problemsOpen} onProblemsOpenChange={setProblemsOpen}
          />
          {runView && runPresentation === 'trace' && (
            <LifecycleStrip waiting={Boolean(waiting)} attempt={attempt} phase={phase} leadTask={waiting?.handoverFrom === leadId ? 'done' : leadAgent?.taskState.toLowerCase() ?? (phase === 'queued' ? 'queued' : 'ready')} result={lifecycleResult} mode={session.mode} lastSeq={session.lastSeq} cursor={session.cursor} onCursor={session.setCursor} onClose={closeRun} costUsd={projection.totals.costUsd} elapsed={elapsed} />
          )}
          {doc.diskNotice && <p className="lw-notice t-meta" style={{ margin: 0 }}>{doc.diskNotice}</p>}
          {doc.entrypointProblem && doc.entrypointProblem.candidates.length > 0 && editable && <EntrypointProblemBar problem={doc.entrypointProblem} onPromote={doc.promoteEntrypoint} />}
          {doc.modeSwitchBanner && <p className="mode-switch-note t-meta" style={{ margin: 0, pointerEvents: 'auto' }}>Drawn edges now sequence this team. <code>dispatch</code> and <code>handoff</code> are withdrawn.</p>}
          {doc.pendingEdgeRemoval && (
            <div role="alert" className="e2 pop-inline t-body" style={{ pointerEvents: 'auto', borderRadius: 'var(--r-md)' }}>
              <span>Removing the last edge returns this team to self-organizing.</span>
              <button type="button" className="btn btn-primary" onClick={doc.undoLastEdgeRemoval}>Undo</button>
              <button type="button" className="btn" onClick={doc.keepLastEdgeRemoval}>Keep it</button>
            </div>
          )}
        </div>

        {!runView && !runSetup && !inspecting && doc.nodes.length > 0 && (
          <aside className="build-outcome" aria-label="Expected team output">
            <span className="delivery-eyebrow">Team output</span>
            <h2>Choose who delivers the result.</h2>
            <label>Final response by
              <select aria-label="Final response owner" value={responderFromDoc ?? ''} disabled={!editable || doc.mode !== 'pipeline'} onChange={(event) => doc.promoteResponder(event.target.value)}>
                {!responderFromDoc && <option value="" disabled>Choose an agent</option>}
                {doc.nodes.map((node) => <option key={node.id} value={node.id}>{node.data.agent.name}</option>)}
              </select>
            </label>
            <p>{doc.mode === 'pipeline' ? 'This agent’s answer becomes the team output. Each stage keeps its own work and evidence.' : 'The lead agent delivers the team’s final response.'}</p>
            <button className="btn btn-primary" onClick={() => { setRunSetup(true); setRunPresentation('delivery') }}>Preview next run</button>
          </aside>
        )}

        {!runView && !runSetup && outputEditorOpen && <aside className="node-inspector" aria-label="Selected output settings"><div className="inspector-head"><div><span className="eyebrow">Selected output</span><strong>{composerLayout.output?.name || 'Team response'}</strong></div><button className="icon-button" aria-label="Close output settings" onClick={() => setOutputEditorOpen(false)}><X size={16} /></button></div><div className="inspector-fields"><label>Deliverable name<input value={composerLayout.output?.name ?? 'Team response'} onChange={e => composerLayout.setOutput({ name: e.target.value, format: composerLayout.output?.format ?? 'Markdown report' })} /></label><label>Format<select value={composerLayout.output?.format ?? 'Markdown report'} onChange={e => composerLayout.setOutput({ name: composerLayout.output?.name ?? 'Team response', format: e.target.value })}><option>Markdown report</option><option>HTML dashboard</option><option>Document and files</option></select></label><label>Produced by<select value={responderFromDoc ?? ''} disabled={!editable || doc.mode !== 'pipeline'} onChange={e => doc.promoteResponder(e.target.value)}>{doc.nodes.map(node => <option key={node.id} value={node.id}>{node.data.agent.name}</option>)}</select></label><p>Connect the final harness to make its ownership explicit.</p><small>{composerLayout.saving ? 'Saving…' : 'Applies to the next new run.'}</small></div></aside>}
        {inspectedNode && !inspectedCapability && !inspectedEvidence && (
          <WorkspaceInspector
            startAdvanced={forcedInspectorField?.agentId === inspectedNode.id} fixHint={forcedInspectorField?.agentId === inspectedNode.id ? forcedInspectorField.hint : undefined} onDismissFixHint={() => setForcedInspectorField(null)}
            harnesses={harnesses} harnessId={inspectedHarnessId ?? undefined} onHarnessChange={(id: string) => { const harness = harnesses.find(item => item.id === id); if (harness) doc.updateAgentSpawn(inspectedNode.id, { env: {}, cwd: '.', ...inspectedNode.data.agent.spawn, ...harness.spawn }) }}
            node={inspectedNode} isEntrypoint={inspectedNode.id === doc.entrypoint} isResponder={inspectedNode.id === responderFromDoc} fieldProblems={doc.fieldProblemsByAgent.get(inspectedNode.id)} readOnly={!editable} pipeline={doc.mode === 'pipeline'}
            modelOptions={modelOptionsForAgent(inspectedNode.data.agent, doc.nodes.map((node) => node.data.agent), harnesses, inspectedModels)} defaultThinkingEffort={inspectedDefaultThinkingEffort} modelOptionsLoading={inspectedModelsLoading} modelOptionsError={inspectedModelsError} onRetryModelOptions={() => { if (inspectedHarnessId) modelCatalogCache.current.delete(inspectedHarnessId); setModelCatalog({ harnessId: '', models: [], error: null }); setModelCatalogRetry((attempt) => attempt + 1) }}
            onFieldBlur={(field) => doc.touchField(inspectedNode.id, field)} onRename={(field, value) => { retireFixHint(inspectedNode.id, field); doc.renameAgent(inspectedNode.id, field, value) }} onModelChange={(value) => doc.updateAgentModel(inspectedNode.id, value)} onThinkingEffortChange={(value) => doc.updateAgentThinkingEffort(inspectedNode.id, value)}
            onCwdChange={(value) => doc.updateAgentCwd(inspectedNode.id, value)} onBudgetChange={(value) => { retireFixHint(inspectedNode.id, 'limitUsd'); doc.updateAgentBudget(inspectedNode.id, value) }} onWarnAtChange={(value) => doc.updateAgentWarnAt(inspectedNode.id, value)}
            onAllowRecruitingChange={(value) => doc.updateAgentAllowRecruiting(inspectedNode.id, value)} onPromoteEntrypoint={() => doc.promoteEntrypoint(inspectedNode.id)} onPromoteResponder={() => doc.promoteResponder(inspectedNode.id)} onDelete={() => requestNodeDelete([inspectedNode.id])}
            briefCount={memory?.entries.length ?? 0} teamDeliverAs={memory?.deliverAs}
            onMemoryBriefChange={(reads) => doc.updateAgentMemory(inspectedNode.id, 'brief', reads ? undefined : false)}
            onDeliverAsChange={(deliverAs) => doc.updateAgentMemory(inspectedNode.id, 'deliverAs', deliverAs === (memory?.deliverAs ?? 'native-file') ? undefined : deliverAs)}
            onClose={() => { setForcedInspectorField(null); doc.onNodesChange([{ id: inspectedNode.id, type: 'select', selected: false }]) }}
          />
        )}
        {inspectedCapability && !inspectedNode && !inspectedEvidence && (
          <WorkspaceResourceInspector
            onRemove={inspectedCapabilityNode ? () => { removeCapabilityCards([inspectedCapabilityNode.id]); clearSelection() } : undefined}
            {...inspectedCapability}
            placed={Boolean(inspectedCapabilityNode)}
            connectedAgents={inspectedCapabilityAgents}
            agents={doc.nodes.filter((node) => node.data.agent.kind !== 'operator').map((node) => ({ id: node.id, name: node.data.agent.name, harnessId: harnessIdForAgent(node.data.agent, harnesses), harness: appLabelForAgent(node.data.agent, harnesses), connected: (node.data.agent.capabilities ?? []).some((skill) => skill.name === inspectedCapability.item.name) }))}
            onToggleAgent={(id, connected) => {
              if (!editable || inspectedCapability.kind !== 'skill') return
              const agent = doc.nodes.find((node) => node.id === id)?.data.agent
              if (!agent) return
              const current = agent.capabilities ?? []
              const name = inspectedCapability.item.name
              if (connected && !inspectedCapabilityNode) placeCapability(JSON.stringify({kind: 'skill', name, source: inspectedCapability.item.source}), flow.screenToFlowPosition({x: window.innerWidth / 2, y: window.innerHeight / 2}))
              doc.setAgentCapabilities(id, connected ? [...current.filter((skill) => skill.name !== name), {kind: 'skill', name}] : current.filter((skill) => skill.name !== name))
              setStatusAnnouncement(`${name} ${connected ? 'is required by' : 'was disconnected from'} ${agent.name}. Save the team to keep this change.`)
            }}
            readOnly={!editable}
            onAdd={() => {
              if (!editable) return
              const id = placeCapability(JSON.stringify({ kind: inspectedCapability.kind, name: inspectedCapability.item.name, source: inspectedCapability.item.source }), flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
              if (id) setSelectedCapabilities(new Set([id]))
            }}
            onReveal={() => {
              if (!inspectedCapabilityNode) return
              const node = flow.getNode(inspectedCapabilityNode.id)
              if (node) void flow.fitView({ nodes: [node], padding: 0.7, maxZoom: 1, duration: 300 })
            }}
            onClose={clearSelection}
          />
        )}
        {scheduleOpen && visibleSchedule && (
          <SchedulePanel
            schedule={visibleSchedule}
            problems={[...new Set(scheduleProblems.map((problem) => problem.message))]}
            readOnly={!editable}
            dirty={doc.saveState === 'dirty' || doc.saveState === 'new'}
            canSaveFile={doc.isValid && editable}
            savedInEditor={scheduleSaved}
            onSave={saveSchedule}
            onSaveFile={() => void doc.save()}
            onAdvanced={showScheduleYaml}
            onClose={() => setScheduleEditorOpen(false)}
          />
        )}
        {inspectedEvidence && <ActivityPanel evidence={inspectedEvidence} ownerLabel={ownerLabels.get(inspectedEvidence.agentId) ?? inspectedEvidence.agentId} onClose={() => setInspectedEvidenceId(null)} />}
        {handover && (
          <HandoverPanel
            modal={runPresentation === 'delivery'}
            text={handover.text} toLabel={handover.toLabel} fromLabel={handover.fromLabel}
            packet={packetFresh ? packet.packet : null}
            packetLoading={packetLoading}
            packetError={packetFresh ? packet.error : null}
            onClose={() => setHandoverAgentId(null)}
          />
        )}
        {memoryPanelOpen && doc.path && (
          <MemoryPanel
            teamPath={doc.path} view={memory} loading={memoryLoading} error={memoryError}
            notebook={notes} notebookLoading={notesLoading} notebookError={notesError}
            onReviseNote={applyNoteRevision} onNoteHistory={readNoteHistory}
            onRetryNotebook={() => setNotesGeneration((generation) => generation + 1)}
            onExportPack={writePack}
            onExcludeInherited={(origin, path) => {
              // The origin is a team id for an inherited team and a pack's origin id for a pack;
              // the path tells them apart, because a pack's entries are spelled
              // `<folder>/brief/<file>` by the loader and a team's are the origin's own spelling.
              const pack = path.includes('.memory/') ? path.split('/brief/')[0] : undefined
              doc.excludeInheritedBrief(pack ? { pack } : { team: origin }, path)
              setMemoryGeneration((generation) => generation + 1)
            }}
            editable={editable}
            onWriteNote={writeBriefNote} onAddFile={addBriefFile} onEditNote={editBriefNote} onRemove={removeBriefEntry}
            onRetry={() => setMemoryGeneration((generation) => generation + 1)}
            onClose={() => setMemoryOpen(false)}
          />
        )}
        {provenanceOpen && !inspectedEvidence && !inspectedNode && !inspectedCapability && runView && (
          <ProvenancePanel projection={projection} ownerLabels={ownerLabels} onInspect={(id) => { const item = projection.evidence.find((candidate) => candidate.id === id); if (item) setFannedAgentId(item.agentId); setInspectedEvidenceId(id) }} onClose={() => setProvenanceOpen(false)} />
        )}

        {alerts.length > 0 && (
          // In the delivery view the run's title and request sit top-left, so alerts dock bottom-left
          // there; on the canvas they keep their place beside the lifecycle strip.
          <div className="panel e1" style={{ left: 'var(--lw-panel-inset)', top: waiting && !deliveryShown ? 132 : undefined, bottom: waiting && !deliveryShown ? undefined : deliveryShown ? 'var(--lw-panel-inset)' : 'calc(var(--lw-panel-inset) + 72px)', width: 'min(320px, calc(100vw - 40px))', maxHeight: '40vh', overflow: 'auto', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', zIndex: 45 }} role="region" aria-label={`Attention, ${alerts.length}`}>
            <span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Attention · {alerts.length}</span>
            {alerts.map((alert) => (
              <div key={alert.id} className={`rt-strip ${alert.id.startsWith('waiting:') ? 'operator-attention' : 'alert'} t-meta`} style={{ borderTop: 0, padding: '6px 8px', borderRadius: 'var(--r-sm)', background: 'var(--color-panel-solid)', alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
                <span className="msg" style={{ whiteSpace: 'normal' }}><b style={{ color: 'var(--color-ink)' }}>{nodeNames.get(alert.agentId) ?? alert.agentId}</b> · {alert.message}</span>
                <span className="alert-acts t-meta">
                  {fixForAlert(alert) && <button type="button" className="link alert-fix" onClick={() => fixAttention(alert)}>Fix in Build <ArrowRight size={12} aria-hidden="true" /></button>}
                  <button type="button" className="link" onClick={() => revealAttention(alert)}>{alert.evidenceId ? 'Show evidence' : 'Show the agent'}</button>
                  <button type="button" className="link" onClick={() => setDismissedAlerts((ids) => new Set([...ids, alert.id]))}>Dismiss</button>
                </span>
              </div>
            ))}
          </div>
        )}

        {layersVisible && runPresentation === 'trace' && <LayerLegend configured={doc.edges.length} observed={observedCount} solo={soloActive} onSolo={setSolo} />}
        {(!runView && !runSetup || runPresentation === 'trace') && <ViewControls prototype={!runView} onFit={fitCanvas} onOrganize={windowWidth >= 768 ? organize : undefined} organizeDisabled={!canOrganize} onUndoOrganize={canOrganize && previousArrangement?.key === arrangementKey ? undoOrganize : undefined} />}

        {(doc.refusal || planRefusal) && <div className="pointer-events-none absolute inset-x-0 z-40 flex justify-center" style={{ bottom: 'calc(var(--lw-panel-inset) + 72px)' }}><EdgeRefusalPopover refusal={doc.refusal ?? { message: planRefusal ?? '' }} onPromote={doc.promoteEntrypoint} onDismiss={() => { doc.dismissRefusal(); setPlanRefusal(null) }} /></div>}
        {composerLayout.error && <div className="pointer-events-none absolute inset-x-0 z-40 flex justify-center" style={{ bottom: 'calc(var(--lw-panel-inset) + 164px)' }}><EdgeRefusalPopover refusal={{ message: `Capability wiring: ${composerLayout.error}` }} onPromote={doc.promoteEntrypoint} onDismiss={composerLayout.dismissError} /></div>}
        {/* After a successful run: the operator reviews what the run wrote, or keeps it, or does
            neither. Never automatic (decision 3), and never on a failed run — a run that failed is
            precisely the one whose observations are least likely to be right, so its notes stay as
            evidence of that run and are not offered for promotion. */}
        <div className="lw-composer-notices" aria-label="Run notices">
        {runView && notes?.keep !== 'never' && record?.status === 'succeeded' && activeRunId && !reviewed.has(activeRunId) && reviewableNotes.length > 0 && (
          <div>
            <ReviewStrip
              attempt={attempt}
              notes={reviewableNotes}
              onReview={() => { clearSelection(); setProvenanceOpen(false); setHandoverAgentId(null); setInspectedEvidenceId(null); setMemoryOpen(true) }}
              onKeepAll={keepAllNotes}
              onDismiss={() => setReviewed((seen) => new Set(seen).add(activeRunId))}
            />
          </div>
        )}
        {/* The mid-run Brief edit, beside the composer the operator is about to type in. */}
        {briefEdit && runView && (
          <div>
            <BriefEditStrip
              title={briefEdit.title}
              editedAt={briefEdit.at}
              holderName={briefHolderName ?? 'This run'}
              suppliedAt={briefSuppliedAt}
              onDismiss={() => setBriefEdit(null)}
            />
          </div>
        )}

        {/* A stopped or failed run: where the work reached, and one action — never "Resume". */}
        {runView && activeRunId && checkpoints?.runId === activeRunId && !reviewed.has(`checkpoint:${activeRunId}`) && (
          <div>
            <CheckpointStrip
              attempt={attempt}
              checkpoints={latestCheckpoints}
              names={nodeNames}
              onStart={startFromCheckpoint}
              onDismiss={() => setReviewed((seen) => new Set(seen).add(`checkpoint:${activeRunId}`))}
            />
          </div>
        )}
        </div>

        <Composer compact={deliveryShown} agentNames={nodeNames}
          reviewContext={waiting?.context ? { label: `What ${nodeNames.get(waiting.handoverFrom ?? '') ?? waiting.name} handed over`, text: waiting.context } : undefined}
          replyAgents={(record?.replyableAgents ?? []).map((id) => ({ id, name: nodeNames.get(id) ?? id }))}
          onReply={(id) => void replyToAgent(id)} replySending={answerSending}
          dirty={['dirty', 'new'].includes(doc.documentChipState)} onAnswer={(sendBack) => void sendAnswer(sendBack)}
          note={!runView && composerState.kind === 'ready' && routine ? `Routine: ${routine.enabled ? routine.describe : 'paused'} · next ${describeNextFire(routine.nextAt)}${routine.deliver?.notion ? ' · delivers to Notion' : ''}` : undefined}
          mode={doc.mode} stepCount={doc.pipelineSteps.length || doc.nodes.length} anomalyCount={anomalies.length} state={composerState}
          value={composerText} onChange={setComposerText} onSubmit={() => void submit()} onStop={() => void stop()} onRetry={retry} onNewRun={() => void submit()}
          followUpStages={followUpStages} followUpTarget={followUpTarget} onFollowUpTargetChange={setFollowUpTarget}
          onFollowUp={runView && activeRunId ? () => void followUp() : undefined}
          onOpenMode={() => { setModeOpen((open) => !open); setHistoryOpen(false) }} onOpenHistory={() => { setHistoryOpen((open) => !open); setModeOpen(false) }} modeOpen={modeOpen} historyOpen={historyOpen} switchBanner={doc.modeSwitchBanner}
          memoryCount={memory?.entries.length ?? 0} memoryOpen={memoryPanelOpen} onOpenMemory={() => {
            // Opening Memory clears the selection, because the right dock holds one panel and a
            // selected node owns it (§13's mutual exclusion, enforced in `memoryPanelOpen`).
            clearSelection()
            setProvenanceOpen(false)
            setHandoverAgentId(null)
            setInspectedEvidenceId(null)
            setMemoryOpen((open) => !open)
          }}
        >
          {modeOpen && (
            <ModePopover mode={doc.mode} steps={doc.pipelineSteps} nodeNames={nodeNames} entrypointName={doc.entrypoint ? nodeNames.get(doc.entrypoint) ?? doc.entrypoint : null} guards={doc.teamGuards} budget={doc.teamBudget} anomalies={anomalies} readOnly={!editable} onUpdateGuards={doc.updateTeamGuards} onUpdateBudget={doc.updateTeamBudget} onClose={() => setModeOpen(false)} schedule={routine} onRunRoutineNow={() => void runRoutineNow()} routineBusy={routineBusy} />
          )}
          {historyOpen && (
            <RunHistory entries={historyEntries} currentId={activeRunId} loading={!history.loaded} error={history.error ?? history.unavailable} onOpen={(entry) => {
              setHistoryOpen(false)
              if (entry.teamPath && entry.teamPath !== doc.path) window.location.assign(historyRunUrl(entry))
              else showRun(entry.id)
            }} onClose={() => setHistoryOpen(false)} />
          )}
        </Composer>

        {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
        {discardConfirm && <InlineConfirm message="Discard changes and reload from disk?" confirmLabel="Discard changes" onConfirm={() => { setDiscardConfirm(false); void doc.reloadFromDisk() }} onCancel={() => setDiscardConfirm(false)} />}
        {pendingNodeDelete.length > 0 && <InlineConfirm message={`Delete ${pendingNodeDelete.length === 1 ? 'this node and its connections' : `${pendingNodeDelete.length} nodes and their connections`}?`} confirmLabel="Delete" onConfirm={() => { deleteNodes(pendingNodeDelete); setPendingNodeDelete([]) }} onCancel={() => setPendingNodeDelete([])} />}
        {openPathOpen && <OpenTeamSheet onClose={() => setOpenPathOpen(false)} />}
        {newTeamSheet && <NewTeamSheet harnesses={harnesses} openTeamUnsaved={['dirty', 'invalid', 'conflict'].includes(doc.documentChipState)} onClose={() => setNewTeamSheet(false)} onCreateBlank={(name, path) => { doc.createNewDocument(name, path); setNewTeamSheet(false); showRun(null); onDocumentOpen() }} />}
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
  const { teams, error } = useTeamList()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = (teams ?? []).filter((team) => !needle || teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
  return (
    <Sheet label="Open a team" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (matches[0]) openTeam(matches[0].path) }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <label className="field"><span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Open a team</span><input autoFocus className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a team by name" /></label>
        <div className="pop-list" style={{ padding: 0, maxHeight: 280 }} aria-label="Your teams">
          {teams === null && !error && <p role="status" className="pop-empty t-meta">Finding teams…</p>}
          {error && <p role="alert" className="pop-empty t-meta" style={{ color: 'var(--color-alert)' }}>{error}</p>}
          {teams !== null && matches.length === 0 && <p className="pop-empty t-meta">No team matches.</p>}
          {matches.map((team) => (
            <button key={team.path} type="button" onClick={() => openTeam(team.path)} className="pop-row" style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              <span className="name t-body-m">{teamDisplayName(team)}</span>
              <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{team.path}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
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

function NewTeamSheet({ harnesses, openTeamUnsaved, onClose, onCreateBlank }: { harnesses: DetectedHarness[]; openTeamUnsaved: boolean; onClose: () => void; onCreateBlank: (name: string, path: string) => void }) {
  const { teams } = useTeamList()
  return <NewTeamDialog harnesses={harnesses} existingPaths={teams?.map((team) => team.path) ?? []} openTeamUnsaved={openTeamUnsaved} onCreateBlank={onCreateBlank} onClose={onClose} />
}
