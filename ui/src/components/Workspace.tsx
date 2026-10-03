import { Background, getNodesBounds, getViewportForBounds, ReactFlow, useNodesInitialized, useReactFlow, useStore, type EdgeChange, type Node, type NodeChange, type OnNodeDrag } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { DetectedHarness } from '../lib/harnesses'
import { briefFileNameFor, exportPack, fetchMemory, fetchNoteHistory, fetchNotes, fetchRunCheckpoints, fetchRunContext, reviseNote, writeMemoryFile, type Checkpoint, type ContextPacket, type MemoryView, type Note, type NotebookView } from '../lib/memory/client'
import type { AgentNode } from '../lib/library/nodeFromDrop'
import type { CapabilityInventory, DetectedCapability } from '../lib/library/client'
import type { CapabilityRef } from '../lib/team-file/types'
import type { TeamSource } from './library/ComponentPalette'
import { PALETTE_WIDTH, clampPaletteWidth } from '../lib/library/paletteWidth'
import { connectedServersByAgent } from '../lib/library/observed'
import { isTerminalRun, runScheduleNow, scheduleForPath, useSchedules } from '../lib/runs/client'
import { ownerLabelFor } from '../lib/runs/graph'
import { appLabelForAgent, harnessIdForAgent, modelOptionsForAgent } from '../lib/models'
import type { OutputNode } from '../lib/runs/graph'
import { causalOrder, DOCK } from '../lib/runs/runOverlay'
import { historyRunUrl, mergeHistory, threadHistory } from '../lib/runs/history'
import { useRunHistory } from '../lib/runs/useRunHistory'
import { useRunSession } from '../lib/runs/useRunSession'
import { snapToGrid } from '../lib/grid'
import { reviewProblems, yamlLineForPath, type ReviewProblem } from '../lib/team-file/problems'
import { appProblemsFor, appProblemSummary, useAppChecks } from '../lib/team-file/appChecks'
import { pipelineTerminal } from '../lib/team-file/pipelineOrder'
import { agentPlace } from '../lib/team-file/agentPlace'
import { unifiedYamlDiff } from '../lib/team-file/diff'
import { useTeamDocument } from '../lib/team-file/useTeamDocument'
import { organizePipeline, type Positions } from '../lib/composer-layout/organize'
import { useComposerLayout } from '../lib/composer-layout/useComposerLayout'
import { RELATION, capabilityForCard, capabilityIsCard, capabilityNodeId, cardId, freeCapabilitySlot, refuseCapabilityEdge, teamFileKind, type CapabilityDragPayload, type CapabilityNodeConfig, type MemoryRef } from '../lib/composer-layout/types'
import { chosenIsFile, chosenName, chosenSource } from '../lib/knowledge/chosen'
import { setThemeMode, useTheme } from '../lib/theme'
import { startTour } from '../lib/tour/store'
import { openFeedback } from '../lib/feedback/report'
import { useAnnouncementQueue } from '../lib/useAnnouncementQueue'
import { useNow } from '../lib/useNow'
import type { AgentField } from '../lib/team-file/validation'
import { recordedReplyText, formatElapsed, isNotebookWrite, type Attention, type Evidence, type RunPhase } from '../lib/watch/events'
import { CanvasActionsContext, type CanvasActions } from './canvas/CanvasActionsContext'
import { CommandPalette, type CommandAction, type InterpretedAction } from './canvas/CommandPalette'
import { ConflictBar } from './canvas/ConflictBar'
import { DocumentSwitcher } from './canvas/DocumentSwitcher'
import { EdgeRefusalPopover } from './canvas/EdgeRefusalPopover'
import { EntrypointProblemBar } from './canvas/EntrypointProblemBar'
import { DeleteTeamDialog } from './home/DeleteTeamDialog'
import { Home } from './home/Home'
import { ALLOW_SWITCHES } from '../lib/team-file/allow'
import type { InspectedCapability } from './canvas/CapabilityInspector'
import { LayerLegend, type LayerSolo } from './canvas/LayerLegend'
import { ParseFailureModal } from './canvas/ParseFailureModal'
import { ScheduleNodeCard } from './canvas/ScheduleNodeCard'
import { SchedulePanel } from './canvas/SchedulePanel'
import { ViewControls } from './canvas/ViewControls'
import { YamlSheet } from './canvas/YamlSheet'
import { ProvEdgeView, WarpEdgeView, WeftEdgeView } from './canvas/edges'
import { BuildAgentCard, BuildCapabilityCard, BuildOutputCard } from './canvas/BuildNodeCard'
import { BuildResourceInspector } from './canvas/BuildResourceInspector'
import { BuildInspector } from './canvas/BuildInspector'
import { ComponentPalette } from './library/ComponentPalette'
import { MessageSquareText, Play, Wrench } from 'lucide-react'
import { Composer, type ComposerState } from './composer/Composer'
import { RoutineNote } from './composer/RoutineNote'
import { RunHistory } from './composer/RunHistory'
import { CAPABILITY_DRAG_MIME, EVIDENCE_DRAG_MIME, LIBRARY_DRAG_MIME } from './library'
import { BriefEditStrip } from './memory/BriefEditStrip'
import { CheckpointStrip } from './memory/CheckpointStrip'
import { MemoryPanel } from './memory/MemoryPanel'
import { ReviewStrip } from './memory/ReviewStrip'
import { ActivityPanel } from './run/ActivityPanel'
import { HandoverPanel } from './run/HandoverPanel'
import { LifecycleStrip } from './run/LifecycleStrip'
import { ProvenancePanel } from './run/ProvenancePanel'
import { DeliveryLane } from './run/DeliveryLane'
import { PermissionPrompt } from './run/PermissionPrompt'
import { EvidenceNodeCard, MoreEvidenceCard, OutputNodeCard, PromptNodeCard, RunNodeCard } from './run/StoryNodes'
import { ChipDot } from './ui/glyphs'
import { SegmentThumb } from './ui/SegmentThumb'
import { AttentionAlerts } from './workspace/AttentionAlerts'
import { BuildHeading } from './workspace/BuildHeading'
import { capabilityEdgeId } from './workspace/canvasGraph'
import { OutputEditor } from './workspace/OutputEditor'
import { ConflictSheetFooter, InlineConfirm, NewTeamSheet, OpenTeamSheet, SaveCopySheet } from './workspace/Sheets'
import { useCanvasGraph } from './workspace/useCanvasGraph'
import { useModelCatalog } from './workspace/useModelCatalog'
import { useRunController } from './workspace/useRunController'
import { useWorkspaceShortcuts } from './workspace/useWorkspaceShortcuts'
import { TeamStory } from './workspace/TeamStory'
import { NeedsYouTray } from './workspace/NeedsYouTray'
import { useNeedsYou } from '../lib/story/useNeedsYou'
import { matchTeam, parseIntent } from '../lib/story/intent'
import { APPROVAL_TEXT } from '../lib/story/needsYou'
import { DEPTH_LABEL, DEPTH_ZOOM, STORY_MAX_ZOOM } from '../lib/story/depth'
import { harnessForRole, ROLE_PRESETS, roleSource } from '../lib/library/roles'
import { savedJobPreset, useSavedJobs } from '../lib/library/jobs'
import type { LibrarySource } from '../lib/library/types'
import { OPERATOR_SOURCE } from '../lib/library/fixtures'
import { teamSentence } from '../lib/story/teamSentence'
import { depthForZoom } from '../lib/story/depth'
import { WorkspaceMenu } from './workspace/WorkspaceMenu'
import { useAsk } from '../lib/ask/useAsk'
import { DEFAULT_ROUTINE_NOTION_TITLE } from '../lib/notion/connection'
import type { AskContext } from '../lib/ask/client'
import { AskButton } from './ask/AskButton'
import type { CardActions } from './ask/AskCards'
import { proposalSource, sameTeamFile, teamFileForAsk, useAskActions } from './ask/useAskActions'

// The Ask panel is code-split like the Markdown stack: most visits never open it.
const AskPanel = lazy(() => import('./ask/AskPanel').then((module) => ({ default: module.AskPanel })))

// One canvas anatomy for both surfaces. Run ("Full trace") draws the team the operator composed,
// so it must be recognisably the same object: the agent and capability cards are the Build cards,
// with the run's projected state layered onto them. Only the nodes a run alone owns — the attempt,
// its evidence and the response it produced — have a Run-only renderer, and only the response node
// differs between the two, because before a run there is no answer to read.
const nodeTypes = { agent: BuildAgentCard, schedule: ScheduleNodeCard, capability: BuildCapabilityCard, prompt: PromptNodeCard, run: RunNodeCard, evidence: EvidenceNodeCard, more: MoreEvidenceCard, response: OutputNodeCard }
// One set of lines and one word for each relationship on both canvases (ADR 0041); a run's own
// routing — the arc onto the Output node's top handle, the resource lane — rides the edge data.
const edgeTypes = { warp: WarpEdgeView, weft: WeftEdgeView, prov: ProvEdgeView }
// Before a run there is no answer to show, so the Output card is the planned one.
const buildNodeTypes = { ...nodeTypes, response: BuildOutputCard }
const EMPTY_CAPABILITY_INVENTORY: CapabilityInventory = { skills: [], tools: [], sources: [] }
const EMPTY_EVIDENCE: readonly Evidence[] = []
/** Where this browser keeps the add panel's width. */
const PALETTE_WIDTH_KEY = 'loomwatch.paletteWidth'

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
/**
 * What the panel says about a folder or file card (ADR 0042): what every agent connected to it is
 * given, in the words the run bears out (ADR 0035).
 */
function chosenItem(card: CapabilityNodeConfig): DetectedCapability {
  const path = card.path ?? ''
  return {
    id: card.id,
    name: card.name,
    source: chosenSource(path),
    path,
    status: 'Local only',
    detail: chosenIsFile(path)
      ? 'A file added to this team. Each agent connected to it is given its text with its instructions: all of it when it is short, otherwise the opening and a full copy it can open.'
      : 'A folder on this computer, read where it is on every run. Each agent connected to it is given the folder\u2019s listing and README with its instructions, and may open any file in it. It never changes the folder.',
  }
}

function memoryKey(memory: MemoryRef | undefined): string {
  if (memory?.team) return `team:${memory.team}`
  if (memory?.pack) return `pack:${memory.pack}`
  return ''
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
  // Semantic zoom: the canvas carries its depth so every card can say more or less (lib/story/depth.ts).
  const depth = useStore((store) => depthForZoom(store.transform[2]))
  // Every run, in every team, that is waiting on the operator (lib/story/needsYou.ts).
  const needsYou = useNeedsYou()
  const needsYouTray = (onScreenRunId: string | null = null) => <NeedsYouTray tickets={needsYou.tickets} working={needsYou.working} onAnswer={needsYou.answer} onPermission={needsYou.answerPermission} onDismiss={needsYou.dismiss} onScreenRunId={onScreenRunId} />
  const { resolved: theme } = useTheme()
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)
  const editable = !doc.readOnlyReason

  // ---- chrome state --------------------------------------------------------------------
  const [outputEditorOpen, setOutputEditorOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [openPathOpen, setOpenPathOpen] = useState(false)
  const [newTeamSheet, setNewTeamSheet] = useState(false)
  const [saveCopyOpen, setSaveCopyOpen] = useState(false)
  const [deleteTeamOpen, setDeleteTeamOpen] = useState(false)
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
  // The add panel's width, dragged at its edge. A convenience for whoever is looking, so it is kept
  // in this browser only, and a storage that throws (a private window) leaves the default.
  const [paletteWidth, setPaletteWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(PALETTE_WIDTH_KEY))
      return saved ? clampPaletteWidth(saved) : PALETTE_WIDTH.default
    } catch {
      return PALETTE_WIDTH.default
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(PALETTE_WIDTH_KEY, String(paletteWidth))
    } catch {
      // Not kept; the panel still has this width until the page is closed.
    }
  }, [paletteWidth])
  /** The agent a skill, tool, folder or file is being dragged over, so its card can say it takes it. */
  const [dropAgentId, setDropAgentId] = useState<string | null>(null)
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
  const [handledScheduleSave, setHandledScheduleSave] = useState(0)
  const scheduleWasOpenRef = useRef(false)
  const [schedulePath, setSchedulePath] = useState<string | null>(null)
  const [selectedCapabilities, setSelectedCapabilities] = useState<ReadonlySet<string>>(new Set())
  const [selectedCapabilityEdgeIds, setSelectedCapabilityEdgeIds] = useState<ReadonlySet<string>>(new Set())
  const [inspectedCapability, setInspectedCapability] = useState<InspectedCapability | null>(null)
  const [planRefusal, setPlanRefusal] = useState<string | null>(null)

  // ---- run state -----------------------------------------------------------------------
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId)
  const [runSetup, setRunSetup] = useState(false)
  const [runPresentation, setRunPresentation] = useState<'delivery' | 'trace'>('delivery')
  const [lastOpenedRun, setLastOpenedRun] = useState<{ id: string; path: string | null } | null>(initialRunId ? { id: initialRunId, path: doc.path } : null)
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
  const observedConnected = useMemo(() => connectedServersByAgent(projection.agents), [projection.agents])
  const routine = useMemo(() => scheduleForPath(schedules.entries, doc.path), [schedules.entries, doc.path])
  // The registry knows the canonical responder for its own runs; history falls back to the document.
  const responderId = record?.responder ?? responderFromDoc
  // The team as one sentence above the Build canvas (lib/story/teamSentence.ts).
  const storyParts = useMemo(() => teamSentence({
    agents: doc.nodes.map((node) => node.data.agent),
    edges: doc.edges.map((edge) => ({ from: edge.source, to: edge.target })),
    steps: doc.pipelineSteps,
    entrypoint: doc.entrypoint ?? '',
    responder: responderFromDoc,
    schedule: doc.teamSchedule,
    deliver: doc.teamDeliver,
  }), [doc.nodes, doc.edges, doc.pipelineSteps, doc.entrypoint, responderFromDoc, doc.teamSchedule, doc.teamDeliver])
  const storyShown = storyParts.length > 0

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
  // The add panel is composition chrome; once a run is on screen it folds. Keyed on the path too:
  // before the document loads there is no panel mounted to hear the event. The full trace mounts
  // the panel again, and reviewing a run starts with the graph, not the catalogue — the folded
  // panel names what the run used, for when the reader wants it (ADR 0041).
  useEffect(() => {
    if (activeRunId && doc.path) window.dispatchEvent(new Event('loomwatch:close-library'))
  }, [activeRunId, doc.path, runPresentation])

  useEffect(() => {
    const resize = () => { setWindowWidth(window.innerWidth); setWindowHeight(window.innerHeight) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // §15.2.2: the permanent Prompt node is the composer seen in a second place, so clicking it
  // puts the caret in the one editor rather than opening another.
  const focusComposer = useCallback(() => {
    document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus()
  }, [])

  const closeRun = useCallback(() => {
    if (activeRunId) setLastOpenedRun({ id: activeRunId, path: doc.path })
    showRun(null)
  }, [activeRunId, doc.path, showRun])

  // ---- team graph ----------------------------------------------------------------------
  const stepById = useMemo(() => new Map(doc.pipelineSteps.map((step) => [step.id, { ...step, step: step.step + (doc.teamSchedule ? 1 : 0) }])), [doc.pipelineSteps, doc.teamSchedule])
  const nodeNames = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node.data.label])), [doc.nodes])
  const agentIds = useMemo(() => doc.nodes.map((node) => node.id), [doc.nodes])
  // A valid team can still name an app this computer does not have — one shared by someone who uses
  // another. The daemon is asked about the document as it is now, not the saved file: Run saves first.
  const docAgents = useMemo(() => doc.nodes.map((node) => node.data.agent), [doc.nodes])
  const commandChecks = useAppChecks(docAgents)
  const appProblems = useMemo(() => appProblemsFor(docAgents, commandChecks, nodeNames), [docAgents, commandChecks, nodeNames])
  const appProblemByAgent = useMemo(() => new Map(appProblems.map((problem) => [problem.agentId, problem.sentence])), [appProblems])
  const appProblemDetail = appProblems.length === 1 ? `${appProblems[0].sentence} ${appProblems[0].remedy}`
    : appProblems.length > 1 ? `${appProblemSummary(appProblems, nodeNames)} Open the list at the top to see what to change.` : null
  // Planned capability wiring lives in a sidecar, never in the team file the daemon runs.
  const composerLayout = useComposerLayout(doc.path, agentIds, doc.saveState !== 'new')
  // Starting, answering and stopping runs, and the composer text they consume.
  const {
    composerText, setComposerText, pendingPrompt, starting, startError, setStartError, answerSending, retryOf,
    submit, stop, sendAnswer, replyToAgent, retry, followUp, startFromCheckpoint, reusePrompt,
  } = useRunController({
    doc, session, history, activeRunId, record, waiting, projectionPrompt: projection.prompt, showRun, followUpTarget,
    output: composerLayout.output, announce: setStatusAnnouncement,
  })

  // The getting-started guide's "Use this example": the request goes in the box, never straight to
  // a run, so the operator still reads it and presses Enter themselves.
  useEffect(() => {
    const compose = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail
      if (typeof text !== 'string') return
      setComposerText(text)
      window.setTimeout(focusComposer, 0)
    }
    window.addEventListener('loomwatch:compose', compose)
    return () => window.removeEventListener('loomwatch:compose', compose)
  }, [setComposerText, focusComposer])

  // ---- Ask LoomWatch (ADR 0033) ------------------------------------------------------------
  // One conversation for every screen: it is told where the person is with each message, and what
  // it makes comes back through here — a proposal onto the canvas, a run to start, a note to send.
  const askContext = useMemo<AskContext>(() => ({
    view: !doc.path ? 'home' : runView || runSetup ? 'run' : 'build',
    teamPath: doc.saveState === 'new' ? null : teamFileForAsk(doc.path, doc.teamsRoot),
    runId: activeRunId,
  }), [doc.path, doc.saveState, doc.teamsRoot, runView, runSetup, activeRunId])
  const ask = useAsk(askContext)
  const askActions = useAskActions({
    doc, conversationId: ask.conversationId, activeRunId, waiting: Boolean(waiting),
    toBuild: () => { if (activeRunId || runSetup) showRun(null) },
    showRun, applyRecord: session.applyRecord, onDocumentOpen,
    // Framed clear of the Ask panel when it is open, so the proposed agents are not behind it.
    frame: (ids) => { void flow.fitView({ ...(ids.length > 0 ? { nodes: ids.map((id) => ({ id })) } : {}), padding: { top: '48px', bottom: '140px', left: '64px', right: ask.open ? '400px' : '64px' }, maxZoom: 1, duration: 420 }) },
  })
  const askCards: CardActions = {
    previewingId: askActions.preview?.proposal.id ?? null,
    savedYamlFor: (file) => (sameTeamFile(doc.path, file) && doc.saveState !== 'new' ? doc.loadedYaml : null),
    busyCard: askActions.busyCard, cardError: askActions.cardError,
    onShowProposal: (id, card) => void askActions.showProposal(id, card),
    onApply: () => void askActions.applyProposal(),
    onDiscard: askActions.discardProposal,
    onStartRun: (card) => void askActions.startRequestedRun(card),
    onDeclineRun: (card) => void askActions.declineRequestedRun(card),
    onOpenRun: askActions.openRun,
    // The note goes into the run's own answer box; the panel steps aside so the whole box shows.
    onUseNote: (card) => { ask.setOpen(false); askActions.takeNote(card) },
  }
  // A proposal made in answer to a message sent from this page goes straight onto the canvas when
  // nothing of the person's would be in the way; otherwise its card waits for "Show on canvas".
  const autoShown = useRef(new Set<string>())
  const showProposal = askActions.showProposal
  const previewing = askActions.preview !== null
  useEffect(() => {
    const since = ask.sentAt
    if (!since || previewing) return
    const fresh = ask.thread.items.flatMap((item) => item.kind === 'assistant' ? item.cards : [])
      .filter((card) => card.kind === 'proposal' && !card.superseded && !card.outcome && !autoShown.current.has(card.id) && Date.parse(card.at) >= since - 2000)
    const card = fresh.at(-1)
    if (!card || card.kind !== 'proposal') return
    for (const each of fresh) autoShown.current.add(each.id)
    // Not over unsaved work, and not over a run the person is watching: the card is right there.
    const unsaved = ['dirty', 'invalid', 'conflict', 'saving'].includes(doc.saveState) || (doc.saveState === 'new' && doc.nodes.length > 0)
    if (!doc.path || (!unsaved && !runView)) void showProposal(card.id, card)
  }, [ask.thread, ask.sentAt, previewing, doc.path, doc.saveState, doc.nodes.length, runView, showProposal])

  const runRoutineNow = useCallback(async () => {
    if (!routine || routineBusy) return
    setRoutineBusy(true)
    setStartError(null)
    try {
      const created = await runScheduleNow(routine.teamPath)
      session.applyRecord(created)
      showRun(created.runId)
      schedules.refresh()
      void history.refresh()
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRoutineBusy(false)
    }
  }, [routine, routineBusy, session, showRun, schedules, history, setStartError])
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
  // ---- every source an agent uses is a card (ADR 0042) ----------------------------------------
  //
  // A skill, tool, folder or file named in an agent's `capabilities` shows as a card even when the
  // sidecar has none for it, so the canvas always says what each agent is given. One card per
  // skill or tool, one per path however each agent labels it, and a line from every agent that
  // uses it. Like a memory card it has no saved position until it is dragged, so it sits under the
  // first agent that uses it, placed by the slot finder click-placed cards use.
  const teamFileCards = useMemo<CapabilityNodeConfig[]>(() => {
    const cards: CapabilityNodeConfig[] = []
    const taken = [...doc.nodes.map((node) => node.position), ...composerLayout.nodes.map((node) => node.position), ...memoryCards.map((node) => node.position)]
    for (const node of doc.nodes) {
      for (const capability of node.data.agent.capabilities ?? []) {
        // Knowledge with no path names nothing (ADR 0036); the agent's Context says so.
        if (capability.kind === 'knowledge' && !capability.path) continue
        const path = capability.kind === 'knowledge' ? capability.path : undefined
        const card = { kind: capability.kind, name: path ? chosenName(path) : capability.name, ...(path ? { path } : {}) }
        const id = cardId(card)
        // The id too: a sidecar card whose name differs only in case is the same card.
        if ([...composerLayout.nodes, ...memoryCards, ...cards].some((other) => other.id === id || capabilityIsCard(capability, other))) continue
        const inventory = capability.kind === 'skill' ? capabilityInventory.skills : capability.kind === 'tool' ? capabilityInventory.tools : []
        const installed = inventory.find((item) => item.name.toLowerCase() === capability.name.toLowerCase())
        const position = freeCapabilitySlot({ x: node.position.x, y: node.position.y + 220 }, taken)
        taken.push(position)
        cards.push({ id, ...card, source: path ? chosenSource(path) : installed?.source ?? 'Not found on this computer', position })
      }
    }
    return cards
  }, [capabilityInventory.skills, capabilityInventory.tools, composerLayout.nodes, doc.nodes, memoryCards])
  const capabilityCards = useMemo(() => [...composerLayout.nodes, ...memoryCards, ...teamFileCards], [composerLayout.nodes, memoryCards, teamFileCards])
  // Skills, tools, folders and files are wired in the team file, so the lines are read from it.
  const wiringEdges = useMemo(() => {
    const cards = [...composerLayout.nodes, ...teamFileCards]
    const seen = new Set<string>()
    const executable = doc.nodes.flatMap((node) =>
      (node.data.agent.capabilities ?? []).flatMap((capability) => {
        const card = cards.find((candidate) => capabilityIsCard(capability, candidate))
        // One line per agent and card, even if the agent names the same folder twice.
        if (!card || seen.has(`${node.id}->${card.id}`)) return []
        seen.add(`${node.id}->${card.id}`)
        return [{ from: node.id, to: card.id }]
      }),
    )
    // Sidecar edges drawn before their kind was executable keep rendering: dropping them would
    // silently erase wiring the operator can see on their canvas. `legacyWiring` below offers to
    // write them into the team file, which is what makes them delivered (ADR 0029).
    const planned = composerLayout.edges.filter(
      (edge) => !executable.some((live) => live.from === edge.from && live.to === edge.to),
    )
    return [...planned, ...executable]
  }, [composerLayout.nodes, composerLayout.edges, doc.nodes, teamFileCards])
  /**
   * A card drawn from the team file exists while some agent uses it. Taking away its last
   * connection keeps it where it is, as a card of this canvas, so it can be connected again
   * instead of vanishing under the pointer.
   */
  /** This team's folders and files for the add panel, one per card, with who reads each. */
  const teamSources = useMemo<TeamSource[]>(() => capabilityCards.filter((card) => card.path && !card.memory).map((card) => ({
    id: card.id,
    name: card.name,
    path: card.path ?? '',
    source: card.source,
    readers: wiringEdges.filter((edge) => edge.to === card.id).map((edge) => nodeNames.get(edge.from) ?? edge.from),
    item: chosenItem(card),
  })), [capabilityCards, wiringEdges, nodeNames])
  const keepUnusedCard = useCallback((card: CapabilityNodeConfig, leaving: string) => {
    if (card.memory || composerLayout.nodes.some((node) => node.id === card.id)) return
    const stillUsed = doc.nodes.some((node) => node.id !== leaving && (node.data.agent.capabilities ?? []).some((capability) => capabilityIsCard(capability, card)))
    if (!stillUsed) composerLayout.place({ kind: card.kind, name: card.name, source: card.source, ...(card.path ? { path: card.path } : {}) }, card.position)
  }, [composerLayout, doc.nodes])
  // Taking a capability card off the canvas must also stop the daemon delivering it, or the team
  // file would keep a skill the operator can no longer see.
  const removeCapabilityCards = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return
    const going = capabilityCards.filter((node) => ids.includes(node.id))
    // Every kind the team file delivers (ADR 0012, 0029), so removing a card stops its delivery.
    if (going.some((card) => teamFileKind(card))) {
      for (const node of doc.nodes) {
        const current = node.data.agent.capabilities ?? []
        const kept = current.filter((capability) => !going.some((card) => capabilityIsCard(capability, card)))
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
  /**
   * Sidecar edges to a card the team file can deliver, from an agent whose team-file entry does not
   * name it: wiring drawn before its kind was executable (ADR 0029). The canvas draws it, but no
   * run receives it until it is written to the team file — which `deliverLegacyWiring` offers.
   * A knowledge card is never one: knowledge is a chosen folder or file (ADR 0036).
   */
  const legacyWiring = useMemo(() => composerLayout.edges.filter((edge) => {
    const card = composerLayout.nodes.find((node) => node.id === edge.to)
    const agent = doc.nodes.find((node) => node.id === edge.from)?.data.agent
    return Boolean(card && agent && teamFileKind(card)
      && !(agent.capabilities ?? []).some((capability) => capabilityIsCard(capability, card)))
  }), [composerLayout.edges, composerLayout.nodes, doc.nodes])
  const deliverLegacyWiring = useCallback(() => {
    const byAgent = new Map<string, CapabilityNodeConfig[]>()
    for (const edge of legacyWiring) {
      const card = composerLayout.nodes.find((node) => node.id === edge.to)
      if (card) byAgent.set(edge.from, [...(byAgent.get(edge.from) ?? []), card])
    }
    for (const [agentId, cards] of byAgent) {
      const current = doc.nodes.find((node) => node.id === agentId)?.data.agent.capabilities ?? []
      const added: CapabilityRef[] = []
      for (const card of cards) {
        const entry = capabilityForCard(card, [...current, ...added])
        if (entry) added.push(entry)
      }
      doc.setAgentCapabilities(agentId, [...current, ...added])
    }
    setStatusAnnouncement(`${legacyWiring.length === 1 ? 'One connection is' : `${legacyWiring.length} connections are`} now in the team file. Save to deliver ${legacyWiring.length === 1 ? 'it' : 'them'} on the next run.`)
  }, [composerLayout.nodes, doc, legacyWiring])
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
    } else {
      // Skills, tools, folders and files all live in the team file (ADR 0012, 0029, 0042).
      const agent = doc.nodes.find((node) => node.id === source)?.data.agent
      const current = agent?.capabilities ?? []
      const kept = current.filter((entry) => !capabilityIsCard(entry, capability))
      if (agent && kept.length !== current.length) {
        keepUnusedCard(capability, source)
        doc.setAgentCapabilities(source, kept)
      }
      // Layouts from before the kind was executable may still hold the same edge in the sidecar.
      if (composerLayout.edges.some((edge) => edge.from === source && edge.to === target)) composerLayout.disconnect(source, target)
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
  }, [capabilityCards, composerLayout, doc, keepUnusedCard, nodeNames])

  const problems = useMemo(() => reviewProblems(doc.entrypointProblem, doc.fieldProblemsByAgent, doc.documentProblems, nodeNames, appProblems), [doc.entrypointProblem, doc.fieldProblemsByAgent, doc.documentProblems, nodeNames, appProblems])
  const scheduleProblems = useMemo(() => problems.filter((problem) => problem.yamlPath?.[0] === 'schedule'), [problems])
  const visibleSchedule = useMemo(() => doc.teamSchedule ?? (scheduleProblems.length > 0 ? { cron: '0 8 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: 'Run this team on schedule.', enabled: true } : null), [doc.teamSchedule, scheduleProblems.length])
  // "Save schedule" means: write the four editable fields into the document model, regenerate the
  // YAML, re-run validation — and only then close. Closing unconditionally (as it used to) hid the
  // case where a schedule problem outlives the save, leaving the operator staring at a red node and
  // a blocked composer with no explanation. The check below reads the *re-validated* problems.
  const saveSchedule = useCallback((schedule: NonNullable<typeof visibleSchedule>) => {
    doc.updateTeamSchedule(schedule)
    setScheduleSaveAttempt((attempt) => attempt + 1)
  }, [doc])
  // Answered once per attempt, in the render that carries the document the attempt produced — the
  // same values an effect would have seen, without a second render to announce them.
  if (scheduleSaveAttempt !== 0 && handledScheduleSave !== scheduleSaveAttempt) {
    setHandledScheduleSave(scheduleSaveAttempt)
    if (scheduleProblems.length > 0) {
      setStatusAnnouncement(`Schedule still needs attention: ${scheduleProblems[0].message}`)
    } else {
      setScheduleSaved(true)
      setStatusAnnouncement('Schedule updated. Save the team file to finish.')
    }
  }
  const showScheduleYaml = useCallback(() => {
    setScheduleEditorOpen(false)
    setYamlHighlightLine(yamlLineForPath(doc.yamlPreview, ['schedule']))
    setYamlOpen(true)
  }, [doc.yamlPreview])
  const openScheduleEditor = useCallback(() => setScheduleEditorOpen(true), [])
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
  // A finished run ends when the daemon says it did. The last recorded event can be much earlier: a
  // run stopped while it waited for you records nothing after the handover, and read "took 63ms".
  const runningNow = live && !isTerminalRun(record?.status)
  const now = useNow(runningNow)
  const elapsedEnd = isTerminalRun(record?.status)
    ? record?.finishedAt ?? projection.updatedAt ?? null
    : !live ? projection.updatedAt ?? record?.finishedAt ?? null : new Date(now).toISOString()
  const elapsed = formatElapsed(projection.startedAt ?? record?.startedAt ?? record?.createdAt ?? null, elapsedEnd)

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

  // ---- one canvas — TNG89_INTERACTION.md §15: the configured graph never moves; a run is drawn onto it.
  const { graph, canvasNodes } = useCanvasGraph({
    runView, doc, session, nodeNames, projection, record, activeRunId, attempt, retryOf, phase, elapsed, lineageLabel,
    orderedAgentIds, ownerLabels, evidenceByAgent, leadId, live, waiting, configuredPairs, overlayPositions, synthMeasurements,
    fannedAgentId, inspectedEvidenceId, packetAgentIds, givenNotes, responderAgent, responderId, responderFromDoc, responseText,
    provenanceOpen, composerText, visibleSchedule, scheduleInvalid: scheduleProblems.length > 0, scheduleEditorOpen, onOpenSchedule: openScheduleEditor,
    capabilityCards, allWiringEdges, editable, selectedCapabilities, selectedCapabilityEdgeIds, focusComposer, removeCapabilityEdge,
    harnesses, outputPlan: composerLayout.output, appProblems: appProblemByAgent,
    sendsTo: doc.teamDeliver?.notion ? 'Notion' : null,
  })

  // Agents an Ask proposal adds or changes wear its dashes until it is applied (styles/ask.css).
  const askMarks = askActions.marks
  const markedNodes = useMemo(() => (askMarks.size === 0 || runView ? canvasNodes : canvasNodes.map((node) => {
    const mark = askMarks.get(node.id)
    return mark ? { ...node, className: [node.className, `ask-${mark}`].filter(Boolean).join(' ') } : node
  })), [canvasNodes, askMarks, runView])

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
  /** Frame the whole team; `maxZoom` caps how far in it may go (Story stays in its own band). */
  const fitCanvas = useCallback((maxZoom?: number) => {
    if (nodeDraggingRef.current) return
    const canvas = canvasRef.current
    const nodes = flow.getNodes()
    if (!canvas || nodes.length === 0) return
    const rect = canvas.getBoundingClientRect()
    const shell = canvas.closest('.lw-shell')
    // The add panel is docked beside the canvas on both tabs (ADR 0041), so the canvas's own
    // rectangle is already the space that is free; only the composer can cover its bottom.
    let bottom = rect.bottom - 24
    for (const selector of ['.lw-composer', '.lw-composer-notices']) {
      const panel = shell?.querySelector(selector)?.getBoundingClientRect()
      if (panel && panel.height > 0) bottom = Math.min(bottom, panel.top - 24)
    }
    // Build keeps the team sentence above the cards, so a fitted team starts below it.
    const top = !runView ? (storyShown ? 124 : 68) : windowWidth >= 768 && windowWidth < 1400 ? 184 : 132
    const bounds = getNodesBounds(nodes)
    const viewport = getViewportForBounds(bounds, Math.max(200, rect.width - 24), Math.max(160, bottom - rect.top - top), runView ? 0.1 : 0.35, Math.min(maxZoom ?? Infinity, runView ? 1 : 1.5), runView ? 0.12 : 0.2)
    void flow.setViewport({ ...viewport, y: viewport.y + top }, { duration: document.hidden ? 0 : 300 })
  }, [flow, windowWidth, runView, storyShown])
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
    const first = window.setTimeout(() => fitCanvas(), 0)
    const settle = window.setTimeout(() => fitCanvas(), 450)
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
          // A card the sidecar does not have yet — one drawn from a `memory.inherits` entry or an
          // agent's `capabilities` — is created at the position the drag settles on. Without this
          // its position would be recomputed from the slot finder on every render and the drag
          // would be lost.
          const known = composerLayout.nodes.some((node) => node.id === change.id)
          if (known) composerLayout.move(change.id, change.position)
          else {
            const card = capabilityCards.find((node) => node.id === change.id)
            if (card) composerLayout.place({ kind: card.kind, name: card.name, source: card.source, memory: card.memory, ...(card.path ? { path: card.path } : {}) }, change.position)
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
            if (capability?.path) {
              // A folder or file is chosen, not discovered (ADR 0036), so it has no Library row.
              setInspectedCapability({ item: chosenItem(capability), kind: capability.kind })
              setInspectedEvidenceId(null)
              setProvenanceOpen(false)
            } else if (capability) {
              const inventory = capability.kind === 'skill' ? capabilityInventory.skills : capability.kind === 'tool' ? capabilityInventory.tools : capabilityInventory.sources
              // A card records the provenance the Library showed when it was placed, and provenance
              // changes whenever another app turns out to hold the same skill. The Library lists one
              // row per kind and name, so the name is the identity; the source only breaks a tie.
              const item = inventory.find((candidate) => candidate.name === capability.name && candidate.source === capability.source)
                ?? inventory.find((candidate) => candidate.name.toLowerCase() === capability.name.toLowerCase())
                ?? { id: capability.id, name: capability.name, source: capability.source, detail: 'Planned capability on this canvas.', status: 'Compatible' as const }
              setInspectedCapability({ item, kind: capability.kind })
              setInspectedEvidenceId(null)
              setProvenanceOpen(false)
            }
          } else {
            setInspectedCapability((current) => current && change.id === cardId({ kind: current.kind, name: current.item.name, path: current.item.path }) ? null : current)
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

  // A name in the team sentence goes to that agent: select it (which opens its settings) and bring
  // it into view at a size where its card can be read.
  const focusAgent = useCallback((id: string) => {
    doc.onNodesChange([
      ...doc.nodes.filter((node) => node.selected && node.id !== id).map((node) => ({ id: node.id, type: 'select' as const, selected: false })),
      { id, type: 'select' as const, selected: true },
    ])
    const node = flow.getNode(id)
    if (node) void flow.setCenter(node.position.x + (node.measured?.width ?? 240) / 2, node.position.y + (node.measured?.height ?? 110) / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 400 })
  }, [doc, flow])

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
  const modelCatalog = useModelCatalog({
    harnessId: inspectedHarnessId,
    agentId: inspectedNode?.id ?? null,
    agentNeedsModel: Boolean(inspectedNode && inspectedNode.data.agent.kind !== 'operator' && !inspectedNode.data.agent.model),
    editable,
    updateAgentModel: doc.updateAgentModel,
  })
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
    const teamFile = doc.path.split('/').pop() ?? doc.path
    const file = briefFileNameFor(body, memory?.entries.map((entry) => entry.path) ?? [], `${teamFile.replace(/\.ya?ml$/i, '')}.brief`)
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
  // Ask docks where the inspector does. It waits behind whatever holds the dock, and asking for it
  // again — the header button, ⌘J, the palette — clears the dock for it.
  const askDockBusy = inspecting || Boolean(handover)
  const askSetOpen = ask.setOpen
  const askSend = ask.ask
  const askOpen = ask.open
  const askFor = useCallback((text?: string) => {
    if (askDockBusy) {
      clearSelection()
      setProvenanceOpen(false)
      setMemoryOpen(false)
      setScheduleEditorOpen(false)
      setHandoverAgentId(null)
    }
    if (text) askSend(text)
    else askSetOpen(true)
  }, [askDockBusy, clearSelection, askSend, askSetOpen])
  const toggleAsk = useCallback(() => {
    if (askOpen && !askDockBusy) askSetOpen(false)
    else askFor()
  }, [askOpen, askDockBusy, askSetOpen, askFor])
  const toggleAskRef = useRef(toggleAsk)
  useEffect(() => { toggleAskRef.current = toggleAsk })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        toggleAskRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /** The inspected capability as a card: what wiring and the canvas compare it by. */
  const inspectedCard = inspectedCapability ? { kind: inspectedCapability.kind, name: inspectedCapability.item.name, source: inspectedCapability.item.source, memory: inspectedCapability.item.memory, ...(inspectedCapability.item.path ? { path: inspectedCapability.item.path } : {}) } : null
  // Kind and name identify a card, and a path identifies a folder or file; a recorded source can
  // lag the Library's (see the card-select handler). Cards drawn from the team file count: they
  // are on the canvas whether or not the sidecar has them.
  const inspectedCapabilityNode = inspectedCard ? (inspectedCard.path
    ? capabilityCards.find((node) => node.id === cardId(inspectedCard))
    : capabilityCards.find((node) => !node.path && node.kind === inspectedCard.kind && node.name === inspectedCard.name && node.source === inspectedCard.source)
      ?? capabilityCards.find((node) => !node.path && node.kind === inspectedCard.kind && node.name.toLowerCase() === inspectedCard.name.toLowerCase())) ?? null : null
  /** The team-file kind the inspected capability is wired as; `null` for memory (ADR 0029). */
  const inspectedTeamKind = inspectedCard ? teamFileKind(inspectedCard) : null
  const wiresInspected = (capability: CapabilityRef) => Boolean(inspectedCard && capabilityIsCard(capability, inspectedCard))
  const inspectedCapabilityAgents = inspectedTeamKind
    ? doc.nodes.filter((node) => (node.data.agent.capabilities ?? []).some(wiresInspected)).map((node) => node.data.agent.name)
    : inspectedCapabilityNode
    ? wiringEdges.filter((edge) => edge.to === inspectedCapabilityNode.id).map((edge) => nodeNames.get(edge.from) ?? edge.from)
    : []
  const inspectCapability = useCallback((item: DetectedCapability, kind: InspectedCapability['kind']) => {
    clearSelection()
    setScheduleEditorOpen(false)
    setProvenanceOpen(false)
    setInspectedCapability({ item, kind })
  }, [clearSelection])
  /** A folder or file row in the add panel: frame its card and open it (ADR 0042). */
  const revealSource = useCallback((id: string) => {
    const card = capabilityCards.find((node) => node.id === id)
    if (!card?.path) return
    inspectCapability(chosenItem(card), 'knowledge')
    setSelectedCapabilities(new Set([id]))
    const node = flow.getNode(id)
    if (node) void flow.fitView({ nodes: [node], padding: 0.7, maxZoom: 1, duration: 300 })
  }, [capabilityCards, flow, inspectCapability])

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
    // A sidecar-only edge is not a reason to refuse: drawing it again is how it reaches the team
    // file and starts being delivered (ADR 0029).
    const refusal = wholeTeam ? null : refuseCapabilityEdge(
      { id: source, isAgent: !sourceCapability },
      { id: target, isAgent: !targetCapability, kind: targetCapability?.kind },
      allWiringEdges.filter((edge) => !legacyWiring.some((legacy) => legacy.from === edge.from && legacy.to === edge.to)),
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
    // A knowledge card with no path was placed from the Library before ADR 0036. Its name points
    // at nothing the daemon can read, so wiring it would only fail the next run.
    if (!teamFileKind(targetCapability)) {
      setPlanRefusal('Knowledge is a folder or file you choose. Use Add folder… or Add file…, then connect its card.')
      return
    }
    const agent = doc.nodes.find((node) => node.id === source)?.data.agent
    const already = agent?.capabilities ?? []
    const entry = capabilityForCard(targetCapability, already)
    if (!entry || !agent) {
      setPlanRefusal('Connect skills, tools, folders and files to the agent that should use them.')
      return
    }
    // Executable configuration, like a skill (ADR 0012): the daemon copies a skill into the
    // agent's workspace, hands a tool to its harness as an MCP server (ADR 0029), and supplies a
    // folder or file from its path (ADR 0035). Provenance and the agent's harness are independent.
    if (!already.some((capability) => capabilityIsCard(capability, targetCapability))) {
      doc.setAgentCapabilities(source, [...already, entry])
    }
    setStatusAnnouncement(`${nodeNames.get(source) ?? source} ${RELATION[targetCapability.kind]} ${targetCapability.name}.`)
  }, [capabilityCards, allWiringEdges, legacyWiring, doc, nodeNames])
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

  /**
   * A job can bring skills (ADR 0030): the new agent's team-file entry already names them, and a
   * card is what shows them on the canvas — `wiringEdges` draws the line once the card exists. Only
   * skills without a card get one, beside where the agent landed.
   */
  const placeJobSkills = useCallback((raw: string, near: { x: number; y: number }) => {
    let source: LibrarySource
    try {
      source = JSON.parse(raw) as LibrarySource
    } catch {
      return
    }
    const taken = [...doc.nodes.map((node) => node.position), ...capabilityCards.map((node) => node.position)]
    for (const capability of source.capabilities ?? []) {
      if (capability.kind !== 'skill' || capabilityCards.some((card) => capabilityIsCard(capability, card))) continue
      const installed = capabilityInventory.skills.find((item) => item.name.toLowerCase() === capability.name.toLowerCase())
      const at = freeCapabilitySlot({ x: snapToGrid(near.x + 280), y: snapToGrid(near.y) }, taken)
      composerLayout.place({ kind: 'skill', name: capability.name, source: installed?.source ?? 'Not found on this computer' }, at)
      taken.push(at)
    }
  }, [capabilityCards, capabilityInventory.skills, composerLayout, doc.nodes])

  /** The agent whose card a flow-space point lands on, or null. A review stop takes nothing. */
  const agentAt = useCallback((point: { x: number; y: number }) => doc.nodes.find((node) => {
    if (node.data.agent.kind === 'operator') return false
    // Before React Flow has measured it, an agent card is `.build-node`'s own size.
    const measured = flow.getNode(node.id)?.measured
    const width = measured?.width ?? 220
    const height = measured?.height ?? 76
    return point.x >= node.position.x && point.x <= node.position.x + width
      && point.y >= node.position.y && point.y <= node.position.y + height
  })?.id ?? null, [doc.nodes, flow])

  /**
   * A skill, tool, folder, file or memory dropped onto an agent connects it to that agent (ADR
   * 0042): the same team-file entry drawing a line writes. The card comes from that entry, so a
   * skill dropped straight from the panel appears under the agent already connected.
   */
  const connectDropped = useCallback((raw: string, agentId: string) => {
    let payload: CapabilityDragPayload
    try {
      payload = JSON.parse(raw) as CapabilityDragPayload
    } catch {
      return
    }
    const agent = doc.nodes.find((node) => node.id === agentId)?.data.agent
    if (!agent || !payload?.kind || !payload.name) return
    const name = nodeNames.get(agentId) ?? agent.name
    if (payload.memory) {
      const key = payload.memory.team ? { team: payload.memory.team } : { pack: payload.memory.pack }
      const existing = doc.memoryInherits.find((entry) =>
        (key.team !== undefined && entry.team === key.team) || (key.pack !== undefined && entry.pack === key.pack))
      // Already read by the whole team: naming one agent would take it away from the rest.
      if (existing && !existing.appliesTo) { setStatusAnnouncement(`The whole team already reads ${payload.name}.`); return }
      doc.addMemoryInherit({ ...key, appliesTo: [...new Set([...(existing?.appliesTo ?? []), agentId])] })
      setStatusAnnouncement(`${name} reads ${payload.name}.`)
      return
    }
    const card = { kind: payload.kind, name: payload.name, ...(payload.path ? { path: payload.path } : {}) }
    const current = agent.capabilities ?? []
    if (current.some((capability) => capabilityIsCard(capability, card))) {
      setStatusAnnouncement(`${name} already ${RELATION[payload.kind]} ${payload.name}.`)
      return
    }
    const entry = capabilityForCard(card, current)
    if (!entry) {
      setPlanRefusal('Knowledge is a folder or file you choose. Use Add folder… or Add file…, then drag it onto the agent.')
      return
    }
    doc.setAgentCapabilities(agentId, [...current, entry])
    setStatusAnnouncement(`${name} ${RELATION[payload.kind]} ${payload.name}. Save the team to keep this change.`)
  }, [doc, nodeNames])

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
    // A capability over an agent's card is connected there on drop, so that card says so now.
    const over = editable && event.dataTransfer.types.includes(CAPABILITY_DRAG_MIME)
      ? agentAt(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
      : null
    setDropAgentId((current) => (current === over ? current : over))
  }, [agentAt, editable, flow, runView])
  const onDrop = useCallback((event: React.DragEvent) => {
    setLibraryDragging(false)
    setDropAgentId(null)
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
      const agentId = agentAt(at)
      if (agentId) connectDropped(capability, agentId)
      else placeCapability(capability, at, overPromptNode(at))
      return
    }
    const raw = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
    if (!raw) return
    event.preventDefault()
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    doc.addAgentFromDrop(raw, at)
    placeJobSkills(raw, at)
  }, [doc, flow, editable, runView, projection.evidence, placeCapability, overPromptNode, placeJobSkills, agentAt, connectDropped])

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
      const raw = (event as CustomEvent<string>).detail
      const at = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      doc.addAgentFromDrop(raw, at)
      placeJobSkills(raw, at)
    }
    window.addEventListener('loomwatch:add-agent', add)
    return () => window.removeEventListener('loomwatch:add-agent', add)
  }, [doc, editable, flow, placeJobSkills])

  // ---- notifications + announcements -----------------------------------------------------
  const waitingAlert: Attention | null = useMemo(() => waiting ? { id: `waiting:${waiting.questionId ?? waiting.since}`, seq: session.lastSeq, agentId: waiting.node, message: waiting.question } : null, [waiting, session.lastSeq])
  // A question waiting on the operator is not an alert on screen: the answer box and the needs-you
  // chip already ask it, and a third copy covered the stages it is about. It still notifies.
  const alerts: Attention[] = session.latest.attention.filter((alert) => !dismissedAlerts.has(alert.id))
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
  // not — a crash, a stop reason — can still name its agent, so both surfaces
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
  }, [notificationsOn, setStartError])

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
    if (doc.nodes.length === 0) return { kind: 'blocked', reason: 'Add an agent before running.' }
    if (!doc.isValid && problems.length > 0) return { kind: 'blocked', reason: `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before this team can run.`, action: { label: 'Review', run: () => setProblemsOpen(true) } }
    // The run would fail the moment it started this agent, so it is not offered.
    if (appProblems.length > 0) return { kind: 'blocked', reason: appProblemSummary(appProblems, nodeNames) ?? '', action: { label: 'Review', run: () => setProblemsOpen(true) } }
    if (doc.mode === 'pipeline' && terminals === 0) return { kind: 'blocked', reason: 'A pipeline run needs exactly one final agent. Every agent in this one hands off to another, so it has none.' }
    if (doc.mode === 'pipeline' && terminals !== 1) return { kind: 'blocked', reason: `A pipeline run needs exactly one final agent. This one has ${terminals}: ${terminalIds.map((id) => nodeNames.get(id) ?? id).join(', ')}.`, action: { label: 'Show on canvas', run: () => { doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: terminalIds.includes(node.id) }))); void flow.fitView({ nodes: doc.nodes.filter((node) => terminalIds.includes(node.id)), padding: 0.35, maxZoom: 1, duration: 300 }) } } }
    if (doc.readOnlyReason) return { kind: 'blocked', reason: doc.readOnlyReason }
    if (doc.documentChipState === 'saving') return { kind: 'saving', filename }
    if (['dirty', 'new'].includes(doc.documentChipState)) return { kind: 'dirty', filename }
    return { kind: 'ready' }
  }, [waiting, answerSending, history.unavailable, runView, session.terminal, record, phase, starting, pendingPrompt, doc, problems.length, appProblems, terminals, terminalIds, nodeNames, filename, flow])

  // ---- commands + keys ----------------------------------------------------------------------
  // With a team open the dialog belongs to the workspace; on Home, Home owns it.
  const openNewTeam = useCallback(() => { if (doc.path) setNewTeamSheet(true); else window.dispatchEvent(new Event('loomwatch:new-team')) }, [doc.path])
  const toggleLibrary = useCallback(() => window.dispatchEvent(new Event('loomwatch:toggle-library')), [])
  const actions = useMemo<CommandAction[]>(() => [
    { label: 'Ask LoomWatch…', shortcut: '⌘J', icon: MessageSquareText, run: () => askFor() },
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
    { label: 'Getting started guide', run: startTour },
    { label: 'Send feedback…', run: () => openFeedback({ screen: !doc.path ? 'home' : runView ? 'run' : 'build' }) },
  ], [doc, editable, composerText, submit, openNewTeam, toggleLibrary, windowWidth, runView, closeRun, cycleProblem, problems.length, theme, notificationsOn, enableNotifications, layersVisible, fitCanvas, organize, canOrganize, askFor])
  // Words the palette has no command for are a request: hand them to Ask LoomWatch.
  const askUnavailable = ask.unavailable
  const askFallback = useCallback((query: string): CommandAction | null => {
    const request = query.trim()
    if (request.startsWith('/') || request.split(/\s+/).length < 2) return null
    return { label: `Ask LoomWatch: “${request}”`, icon: MessageSquareText, disabled: Boolean(askUnavailable), run: () => askFor(request) }
  }, [askUnavailable, askFor])

  // ⌘K's second dialect: plain words or /commands become one proposed action (lib/story/intent.ts).
  // The operator's saved jobs are named there too, so "add a release notes writer" places one.
  const savedJobs = useSavedJobs().jobs
  const interpret = useCallback((query: string): InterpretedAction | null => {
    const parsed = parseIntent(query, savedJobs)
    if (!parsed) return null
    const { intent } = parsed
    const dialect = parsed.exact ? 'exact' as const : 'plain' as const
    const canEdit = Boolean(doc.path) && editable
    const addAgent = (payload: object) => window.dispatchEvent(new CustomEvent('loomwatch:add-agent', { detail: JSON.stringify(payload) }))
    switch (intent.kind) {
      case 'add': {
        const own = intent.saved ? savedJobs.find((candidate) => candidate.id === intent.job) : undefined
        const preset = own ? savedJobPreset(own) : ROLE_PRESETS.find((candidate) => candidate.id === intent.job)
        const source = preset ? roleSource(preset, harnesses) : null
        const app = preset ? harnessForRole(preset, harnesses) : null
        if (!preset) return null
        return { dialect, label: `Add a ${preset.label} to this team`, detail: !canEdit ? 'Open a team first' : app ? `${preset.does} · on ${app.name}` : 'No AI app on this computer can run it', disabled: !canEdit || !source, run: () => { if (source) addAgent(source) } }
      }
      case 'review-step':
        return { dialect, label: 'Add a review step for you', detail: canEdit ? 'The team pauses so you can approve or send work back' : 'Open a team first', disabled: !canEdit, run: () => addAgent(OPERATOR_SOURCE) }
      case 'depth':
        return { dialect, label: `Show the ${DEPTH_LABEL[intent.depth].name} view`, detail: DEPTH_LABEL[intent.depth].hint, disabled: !doc.path, run: () => void flow.zoomTo(DEPTH_ZOOM[intent.depth], { duration: 320 }) }
      case 'approve': {
        const ticket = needsYou.tickets.find((candidate) => candidate.kind === 'review')
        return { dialect, label: ticket ? `Approve ${ticket.teamName}’s review step` : 'Approve a review step', detail: ticket ? ticket.text : 'Nothing is waiting for your approval', disabled: !ticket, run: () => { if (ticket) void needsYou.answer(ticket, APPROVAL_TEXT) } }
      }
      case 'open': {
        const team = matchTeam(intent.query, needsYou.teams)
        return { dialect, label: team ? `Open ${team.name}` : `No team matches “${intent.query}”`, detail: team?.path, disabled: !team, run: () => { if (team) window.location.assign(`/?path=${encodeURIComponent(team.path)}`) } }
      }
      case 'run':
        return { dialect, label: `Run: “${intent.request}”`, detail: doc.path ? 'Puts it in the request box so you can check it, then press Enter' : 'Open a team first', disabled: !doc.path, run: () => { setComposerText(intent.request); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus(), 0) } }
    }
  }, [doc.path, editable, harnesses, flow, needsYou, setComposerText, savedJobs])

  useWorkspaceShortcuts({
    editable, doc, flow, theme, windowWidth, runView, layersVisible, session,
    submit, openNewTeam, toggleLibrary, cycleProblem, clearSelection, closeRun, organize, fitCanvas,
    pendingNodeDelete, setPendingNodeDelete, requestNodeDelete, deleteNodes, discardConfirm, setDiscardConfirm,
    paletteOpen, setPaletteOpen, historyOpen, setHistoryOpen, problemsOpen, setProblemsOpen,
    yamlOpen, setYamlOpen, compareOpen, setCompareOpen, inspectedEvidenceId, setInspectedEvidenceId,
    handoverAgentId, setHandoverAgentId, inspectedCapability, provenanceOpen, setProvenanceOpen, memoryOpen, setMemoryOpen,
    fannedAgentId, setFannedAgentId, setSolo, setSweeping,
    selectedNodes, selectedEdges, selectedCapabilities, selectedCapabilityEdgeIds, capabilityCards, capabilityEdgeById,
    removeCapabilityCards, removeCapabilityEdge,
  })

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
    dropTargetId: dropAgentId,
  }), [editable, doc, stepById, nodeNames, reusePrompt, focusComposer, memory, dropAgentId])

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

  const askNotice = askActions.notice && (
    <div role="status" className="ask-notice e2">
      <span>{askActions.notice.text}</span>
      {askActions.notice.undo && <button type="button" className="btn" onClick={() => { const undo = askActions.notice?.undo; askActions.dismissNotice(); undo?.() }}>Undo</button>}
      <button type="button" className="iconbtn" aria-label="Dismiss" onClick={askActions.dismissNotice}>×</button>
    </div>
  )

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
        // Home's way into Ask is "Describe the job", so the header has no Ask button here, and the
        // box steps aside while the panel is open: one place to type to Ask (ADR 0043).
        topActions={needsYouTray()}
        runs={needsYou.records}
        ask={ask.open ? undefined : { unavailable: ask.unavailable, onAsk: askFor }}
      >
        {paletteOpen && <CommandPalette actions={actions} interpret={interpret} fallback={askFallback} onClose={() => setPaletteOpen(false)} />}
        {openPathOpen && <OpenTeamSheet onClose={() => setOpenPathOpen(false)} />}
        {ask.open && <Suspense fallback={null}><AskPanel ask={ask} view="home" cards={askCards} onHome /></Suspense>}
        {askNotice}
      </Home>
    )
  }

  const shellClass = [
    // `build-graph` is the canvas's own presentation — card and edge anatomy, handles, backdrop —
    // and both surfaces that draw the graph set it. `build-workspace` is Build's page layout alone.
    'lw-shell', !runView && !runSetup ? 'build-workspace' : '', runPresentation === 'trace' || (!runView && !runSetup) ? 'build-graph' : '', `mode-${doc.mode}`, libraryDragging ? 'dragging' : '', nodeDragging ? 'node-dragging' : '', inspecting ? 'inspecting' : '', sweeping ? 'sweeping' : '',
    soloActive === 'configured' ? 'solo-configured' : soloActive === 'observed' ? 'solo-observed' : '', runView ? 'run-shown' : '', deliveryShown ? 'delivery-shown' : '',
    libraryCollapsed ? 'lib-collapsed' : 'lib-open',
    ask.open && !askDockBusy ? 'ask-docked' : '',
  ].filter(Boolean).join(' ')

  return (
    <CanvasActionsContext.Provider value={canvasActions}>
      <div className={shellClass} style={{ '--lw-palette-w': `${paletteWidth}px` } as CSSProperties} data-tour="workspace" data-tour-agents={doc.nodes.length} onDragEnter={(event) => { if (event.dataTransfer.types.includes(LIBRARY_DRAG_MIME) || event.dataTransfer.types.includes(EVIDENCE_DRAG_MIME)) setLibraryDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) { setLibraryDragging(false); setDropAgentId(null) } }}>
        {/* ADR 0040: an agent paused on a request its switches do not cover, waiting for you. */}
        {runView && record && (record.permissionRequests?.length ?? 0) > 0 && (
          <PermissionPrompt
            run={record}
            onAlwaysAllow={editable && sameTeamFile(doc.path, record.teamPath) ? (agentId, key) => {
              doc.updateAgentAllow(agentId, key, true)
              void doc.save()
              const name = doc.nodes.find((node) => node.id === agentId)?.data.agent.name ?? agentId
              setStatusAnnouncement(`${name} is allowed to ${ALLOW_SWITCHES.find((item) => item.key === key)?.label.toLowerCase() ?? key} from now on.`)
            } : undefined}
          />
        )}
        {deliveryShown ? (
          <DeliveryLane
            key={activeRunId ?? 'new-run'}
            planned={runSetup}
            appProblems={appProblemByAgent}
            onNewRun={() => { closeRun(); setRunSetup(true); window.setTimeout(focusComposer, 0) }}
            run={record && !runSetup ? record : null}
            sendsTo={runSetup && doc.teamDeliver?.notion ? 'Notion' : null}
            harnessLabels={new Map(doc.nodes.map((node) => [node.id, appLabelForAgent(node.data.agent, harnesses)]))}
            pipeline={(record?.mode ?? doc.mode) === 'pipeline'}
            linearPipeline={doc.edges.length === doc.nodes.length - 1 && doc.nodes.every((node) => doc.edges.filter((edge) => edge.source === node.id).length <= 1 && doc.edges.filter((edge) => edge.target === node.id).length <= 1)}
            onTrace={() => { if (runSetup) closeRun(); else setRunPresentation('trace') }}
            onAllow={editable ? (agentId, key) => {
              // ADR 0037: switched on and saved in one step, so the next run is not refused again.
              doc.updateAgentAllow(agentId, key, true)
              void doc.save()
              const name = doc.nodes.find((node) => node.id === agentId)?.data.agent.name ?? agentId
              setStatusAnnouncement(`${name} is allowed to ${ALLOW_SWITCHES.find((item) => item.key === key)?.label.toLowerCase() ?? key} from the next run.`)
            } : undefined}
            prompt={record?.prompt ?? projection.prompt ?? composerText} attempt={attempt} phase={phase} branch={retryOf.get(activeRunId ?? '') ? 'Retry of an earlier run' : 'Initiating branch'} elapsed={elapsed} mode={session.mode}
            agents={graph.nodes.filter((node): node is AgentNode => node.type === 'agent').sort((a, b) => runSetup ? (stepById.get(a.id)?.step ?? Infinity) - (stepById.get(b.id)?.step ?? Infinity) : 0)}
            evidenceByAgent={new Map(orderedAgentIds.map((id) => [id, projection.evidence.filter((item) => item.agentId === id)]))}
            ownerLabels={ownerLabels}
            output={(graph.nodes.find((node) => node.id === '__output') as OutputNode | undefined)?.data ?? { text: responseText, phase, phaseText: '', producer: null, producerLabel: 'the responder', mode: session.mode, streaming: false, pending: false, strip: null, compact: false, expanded: false, terminal: session.terminal }}
            projection={projection}
            evidenceComplete={session.evidenceComplete}
            selectedEvidenceId={inspectedEvidenceId}
            focusAgentId={attentionFocusAgentId}
            onInspectEvidence={(id) => setInspectedEvidenceId(id)}
            onSelectAgent={(id) => doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === id })))}
          />
        ) : (
        <div ref={canvasRef} role="application" aria-label={runView ? 'Run graph' : 'Team canvas'} className="lw-canvas" data-depth={depth}>
          <ReactFlow
            nodes={markedNodes}
            edges={runView ? visibleEdges : visibleEdges.filter(edge => edge.source !== '__prompt' || allWiringEdges.some(wire => wire.from === '__prompt'))}
            nodeTypes={runView ? nodeTypes : buildNodeTypes}
            edgeTypes={edgeTypes}
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
                <div className="ghost t-body"><span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span>Add your first helper: pick a job on the left, like Researcher, or drag it here.</span><span className="t-meta">The first agent receives your request.</span></span></div>
              </div>
            )}
          </ReactFlow>
          {!runView && <>{storyParts.length > 0 ? <TeamStory parts={storyParts} onAgent={focusAgent} onSchedule={doc.teamSchedule ? openScheduleEditor : undefined} onConnect={editable ? (edges) => { for (const edge of edges) doc.onConnect({ source: edge.from, target: edge.to, sourceHandle: null, targetHandle: null }) } : undefined} /> : <div className="build-canvas-help"><strong>Connect your agents</strong><span>Drag from the dot on the right of a card to the next card to hand work along.</span></div>}<div className="build-canvas-legend"><span><i />Workflow</span><span><i className="resource" />Resources</span><span>Select a node to edit</span></div></>}
        </div>
        )}
        <div className="lw-sweep" aria-hidden="true" />
        {!runView && !runSetup && <BuildHeading proposal={askActions.preview ? { isNew: askActions.preview.beforeYaml === null, from: proposalSource(askActions.preview.proposal.source), lines: askActions.preview.changes.lines, applying: askActions.preview.applying, error: askActions.preview.error, onApply: () => void askActions.applyProposal(), onDiscard: askActions.discardProposal } : null} agentCount={doc.nodes.length} isValid={doc.isValid} checking={doc.checking} saveState={doc.saveState} appProblem={appProblemDetail} undelivered={editable ? legacyWiring.length : 0} onDeliver={deliverLegacyWiring} onRun={() => { setRunSetup(true); setRunPresentation('delivery'); window.setTimeout(focusComposer, 0) }} />}

        <div aria-live="polite" aria-atomic="true" className="visually-hidden">{politeAnnouncement}</div>
        <div aria-live="assertive" className="visually-hidden">{assertiveAnnouncement}</div>

        <div className="bar-stack">
          {doc.externalChange && <ConflictBar filename={filename} onKeepMine={doc.keepMine} onUseDisk={() => void doc.useDisk()} onCompare={() => setCompareOpen(true)} />}
          {doc.readOnlyReason && !doc.fileGone && <div role="status" className="bar halt"><ChipDot state="readonly" /><span className="msg t-body-m">{doc.readOnlyReason}</span><span className="sub t-meta">Read-only. Pan and inspect still work.</span></div>}
          {harnessesError && !runView && <div role="status" className="bar halt"><ChipDot state="failed" /><span className="msg t-body-m">LoomWatch can't reach the daemon.</span><span className="sub t-mono-sm">{harnessesError}</span><span className="acts"><button type="button" className="btn" onClick={onRetryHarnesses}>Retry now</button></span></div>}
          {startError && <div role="alert" className="bar alert"><ChipDot state="failed" /><span className="msg t-body-m">{startError}</span><span className="acts"><button type="button" className="btn" onClick={() => setStartError(null)}>Dismiss</button></span></div>}
        </div>

        {(!runView && !runSetup || runPresentation === 'trace') && (
          // One add panel on both canvases (ADR 0041); a run adds what it used, at the top.
          <ComponentPalette harnesses={harnesses} harnessSearchPath={harnessSearchPath} knownHarnessIds={knownHarnessIds} harnessesLoading={harnessesLoading} harnessesError={harnessesError} onRetry={onRetryHarnesses} capabilityInventory={capabilityInventory} capabilitiesLoading={capabilitiesLoading} capabilitiesError={capabilitiesError} capabilitiesScannedAt={capabilitiesScannedAt} onRetryCapabilities={() => { onRetryCapabilities(); onRetryHarnesses() }} onInspectCapability={inspectCapability} onDragStateChange={(dragging) => { setLibraryDragging(dragging); if (!dragging) setDropAgentId(null) }} onCollapsedChange={setLibraryCollapsed} observedEvidence={runView ? projection.evidence : EMPTY_EVIDENCE} observedConnected={observedConnected} agentNames={nodeNames} teamSources={teamSources} onRevealSource={revealSource} width={paletteWidth} onResize={windowWidth >= 768 ? setPaletteWidth : undefined} onRevealEvidence={(id) => {
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
          <WorkspaceMenu runView={runView} onHistory={() => setHistoryOpen(true)} onMemory={() => { clearSelection(); setMemoryOpen(true) }} />
          <div className="needs-you-anchor"><AskButton ask={ask} onToggle={toggleAsk} />{needsYouTray(runView ? activeRunId : null)}</div>
          <nav className="workspace-view-tabs" aria-label="Workspace view" data-tour="view-tabs">
            <SegmentThumb />
            <button type="button" aria-pressed={runView || runSetup} onClick={() => { clearSelection(); if (activeRunId) setRunPresentation('delivery'); else if (lastOpenedRun?.path === doc.path) showRun(lastOpenedRun.id); else { setRunSetup(true); setRunPresentation('delivery') } }}><Play size={15} />Run</button>
            <button type="button" aria-pressed={!runView && !runSetup} onClick={() => { clearSelection(); closeRun() }}><Wrench size={15} />Build</button>
          </nav>
          <DocumentSwitcher
            path={doc.path} teamName={doc.teamName} saveState={doc.documentChipState} saveError={doc.saveError} linesDiffer={differ}
            entrypointProblem={doc.entrypointProblem} documentProblems={doc.documentProblems} fieldProblemsByAgent={doc.fieldProblemsByAgent} agentNames={nodeNames} appProblems={appProblems}
            isValid={doc.isValid} readOnlyReason={doc.readOnlyReason} fileGone={doc.fileGone} editingDisabled={windowWidth < 768}
            onSave={() => void doc.save()} onSaveCopy={() => setSaveCopyOpen(true)} onReload={() => void doc.reloadFromDisk()} onDiscard={() => void doc.reloadFromDisk()} onShowYaml={() => setYamlOpen(true)}
            onNewTeam={openNewTeam} onRename={editable ? doc.renameTeam : undefined} onDelete={doc.saveState !== 'new' && !doc.fileGone ? () => setDeleteTeamOpen(true) : undefined}
            onSelectProblem={selectProblem} problemsOpen={problemsOpen} onProblemsOpenChange={setProblemsOpen}
          />
          {runView && runPresentation === 'trace' && (
            <LifecycleStrip waiting={Boolean(waiting)} attempt={attempt} phase={phase} leadTask={waiting?.handoverFrom === leadId ? 'done' : leadAgent?.taskState.toLowerCase() ?? (phase === 'queued' ? 'queued' : 'ready')} result={lifecycleResult} mode={session.mode} lastSeq={session.lastSeq} cursor={session.cursor} onCursor={session.setCursor} elapsed={elapsed} />
          )}
          {doc.diskNotice && <p className="lw-notice t-meta" style={{ margin: 0 }}>{doc.diskNotice}</p>}
          {doc.entrypointProblem && doc.entrypointProblem.candidates.length > 0 && editable && <EntrypointProblemBar problem={doc.entrypointProblem} onPromote={doc.promoteEntrypoint} />}
          {doc.modeSwitchBanner && <p className="mode-switch-note t-meta" style={{ margin: 0, pointerEvents: 'auto' }}>Your agents now hand work along in the order you connected them.</p>}
          {doc.pendingEdgeRemoval && (
            <div role="alert" className="e2 pop-inline t-body" style={{ pointerEvents: 'auto', borderRadius: 'var(--r-md)' }}>
              <span>With no connections left, the first agent now decides who to bring in.</span>
              <button type="button" className="btn btn-primary" onClick={doc.undoLastEdgeRemoval}>Undo</button>
              <button type="button" className="btn" onClick={doc.keepLastEdgeRemoval}>Keep it</button>
            </div>
          )}
        </div>

        {!runView && !runSetup && outputEditorOpen && (
          <OutputEditor
            output={composerLayout.output} onOutputChange={composerLayout.setOutput} saving={composerLayout.saving}
            responder={responderFromDoc} agents={doc.nodes} canChooseResponder={editable && doc.mode === 'pipeline'}
            onPromoteResponder={(id) => doc.promoteResponder(id)} onClose={() => setOutputEditorOpen(false)}
            delivery={{
              deliver: doc.teamDeliver,
              readOnly: !editable,
              teamName: doc.teamName ?? (doc.path?.split('/').pop() ?? 'team').replace(/\.ya?ml$/i, ''),
              routineTitle: doc.teamSchedule?.deliver?.notion ? doc.teamSchedule.deliver.notion.title ?? DEFAULT_ROUTINE_NOTION_TITLE : null,
              onChange: (deliver) => {
                if (!editable) return
                doc.updateTeamDeliver(deliver)
                setStatusAnnouncement(deliver ? 'Answers will be sent to Notion. Save the team to keep this.' : 'Answers will stay in LoomWatch. Save the team to keep this.')
              },
            }}
          />
        )}
        {inspectedNode && !inspectedCapability && !inspectedEvidence && (
          // The same agent panel in Build and in a run (ADR 0041).
          <BuildInspector
            startAdvanced={forcedInspectorField?.agentId === inspectedNode.id} fixHint={forcedInspectorField?.agentId === inspectedNode.id ? forcedInspectorField.hint : undefined} onDismissFixHint={() => setForcedInspectorField(null)}
            harnesses={harnesses} harnessId={inspectedHarnessId ?? undefined} onHarnessChange={(id: string) => { const harness = harnesses.find(item => item.id === id); if (harness) doc.updateAgentSpawn(inspectedNode.id, { env: {}, cwd: '.', ...inspectedNode.data.agent.spawn, ...harness.spawn }) }}
            node={inspectedNode} fieldProblems={doc.fieldProblemsByAgent.get(inspectedNode.id)} readOnly={!editable} pipeline={doc.mode === 'pipeline'}
            place={agentPlace({ agentId: inspectedNode.id, nodes: doc.nodes.map((node) => ({ id: node.id, name: node.data.agent.name, kind: node.data.agent.kind })), edges: doc.edges.map((edge) => ({ from: edge.source, to: edge.target })), steps: doc.pipelineSteps, entrypoint: doc.entrypoint, responder: responderFromDoc, pipeline: doc.mode === 'pipeline' })}
            inheritedMemory={doc.memoryInherits.filter((entry) => !entry.appliesTo || entry.appliesTo.includes(inspectedNode.id)).map((entry) => entry.team ? `${entry.team} · memory` : entry.pack ?? '')}
            onRemoveCapability={(removed) => {
              if (!editable) return
              const remaining = (inspectedNode.data.agent.capabilities ?? []).filter((capability) => !(capability.kind === removed.kind && capability.name === removed.name))
              doc.setAgentCapabilities(inspectedNode.id, remaining)
              setStatusAnnouncement(`${removed.name} was disconnected from ${inspectedNode.data.agent.name}. Save the team to keep this change.`)
            }}
            teamPath={doc.path}
            onAddKnowledge={(added) => {
              if (!editable || added.length === 0) return
              doc.setAgentCapabilities(inspectedNode.id, [...(inspectedNode.data.agent.capabilities ?? []), ...added])
              setStatusAnnouncement(`${added.map((capability) => capability.name).join(', ')} ${added.length === 1 ? 'is' : 'are'} now supplied to ${inspectedNode.data.agent.name}. Save the team to keep this change.`)
            }}
            modelOptions={modelOptionsForAgent(inspectedNode.data.agent, doc.nodes.map((node) => node.data.agent), harnesses, modelCatalog.models)} defaultThinkingEffort={modelCatalog.defaultThinkingEffort} modelOptionsLoading={modelCatalog.loading} modelOptionsError={modelCatalog.error} onRetryModelOptions={modelCatalog.retry}
            onFieldBlur={(field) => doc.touchField(inspectedNode.id, field)} onRename={(field, value) => { retireFixHint(inspectedNode.id, field); doc.renameAgent(inspectedNode.id, field, value) }} onModelChange={(value) => doc.updateAgentModel(inspectedNode.id, value)} onThinkingEffortChange={(value) => doc.updateAgentThinkingEffort(inspectedNode.id, value)}
            onCwdChange={(value) => doc.updateAgentCwd(inspectedNode.id, value)}
            onAllowRecruitingChange={(value) => doc.updateAgentAllowRecruiting(inspectedNode.id, value)} onAllowChange={(key, on) => doc.updateAgentAllow(inspectedNode.id, key, on)} onPromoteEntrypoint={() => doc.promoteEntrypoint(inspectedNode.id)} onDelete={() => requestNodeDelete([inspectedNode.id])}
            briefCount={memory?.entries.length ?? 0} teamDeliverAs={memory?.deliverAs}
            onMemoryBriefChange={(reads) => doc.updateAgentMemory(inspectedNode.id, 'brief', reads ? undefined : false)}
            onDeliverAsChange={(deliverAs) => doc.updateAgentMemory(inspectedNode.id, 'deliverAs', deliverAs === (memory?.deliverAs ?? 'native-file') ? undefined : deliverAs)}
            onClose={() => { setForcedInspectorField(null); doc.onNodesChange([{ id: inspectedNode.id, type: 'select', selected: false }]) }}
          />
        )}
        {inspectedCapability && !inspectedNode && !inspectedEvidence && (
          <BuildResourceInspector
            key={`${inspectedCapability.kind}:${inspectedCapability.item.id}:${inspectedCapabilityNode?.id ?? ''}`}
            onRemove={inspectedCapabilityNode ? () => { removeCapabilityCards([inspectedCapabilityNode.id]); clearSelection() } : undefined}
            {...inspectedCapability}
            placed={Boolean(inspectedCapabilityNode)}
            connectedAgents={inspectedCapabilityAgents}
            agents={doc.nodes.filter((node) => node.data.agent.kind !== 'operator').map((node) => ({ id: node.id, name: node.data.agent.name, harnessId: harnessIdForAgent(node.data.agent, harnesses), harness: appLabelForAgent(node.data.agent, harnesses), connected: (node.data.agent.capabilities ?? []).some(wiresInspected) }))}
            onToggleAgent={(id, connected) => {
              const kind = inspectedTeamKind
              if (!editable || !kind || !inspectedCard) return
              const agent = doc.nodes.find((node) => node.id === id)?.data.agent
              if (!agent) return
              const current = agent.capabilities ?? []
              const name = inspectedCapability.item.name
              const others = current.filter((capability) => !wiresInspected(capability))
              const entry = capabilityForCard(inspectedCard, others)
              if (!entry) return
              if (connected && !inspectedCapabilityNode) placeCapability(JSON.stringify({ kind: inspectedCapability.kind, name, source: inspectedCapability.item.source, path: inspectedCard.path }), flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
              if (!connected && inspectedCapabilityNode) keepUnusedCard(inspectedCapabilityNode, id)
              doc.setAgentCapabilities(id, connected ? [...others, entry] : others)
              setStatusAnnouncement(`${name} ${connected ? (kind === 'skill' ? 'is required by' : kind === 'knowledge' ? 'is supplied to' : 'is connected to') : 'was disconnected from'} ${agent.name}. Save the team to keep this change.`)
            }}
            readOnly={!editable}
            onAdd={() => {
              if (!editable) return
              const id = placeCapability(JSON.stringify({ kind: inspectedCapability.kind, name: inspectedCapability.item.name, source: inspectedCapability.item.source, path: inspectedCapability.item.path }), flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
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
            status={routine ? <RoutineNote schedule={routine} onRunNow={() => void runRoutineNow()} busy={routineBusy} /> : undefined}
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
            unsavedEntries={doc.briefPaths.filter((path) => !memory?.entries.some((entry) => entry.path === path))}
          />
        )}
        {provenanceOpen && !inspectedEvidence && !inspectedNode && !inspectedCapability && runView && (
          <ProvenancePanel projection={projection} ownerLabels={ownerLabels} onInspect={(id) => { const item = projection.evidence.find((candidate) => candidate.id === id); if (item) setFannedAgentId(item.agentId); setInspectedEvidenceId(id) }} onClose={() => setProvenanceOpen(false)} />
        )}

        <AttentionAlerts
          alerts={alerts} nodeNames={nodeNames} waiting={Boolean(waiting)} deliveryShown={deliveryShown}
          canFix={(alert) => fixForAlert(alert) !== null} onFix={fixAttention} onReveal={revealAttention}
          onDismiss={(alert) => setDismissedAlerts((ids) => new Set([...ids, alert.id]))}
        />

        {ask.open && <Suspense fallback={null}><AskPanel ask={ask} view={askContext.view} cards={askCards} hidden={askDockBusy} /></Suspense>}
        {askNotice}

        {layersVisible && runPresentation === 'trace' && <LayerLegend configured={doc.edges.length} observed={observedCount} solo={soloActive} onSolo={setSolo} />}
        {(!runView && !runSetup || runPresentation === 'trace') && <ViewControls onFit={() => fitCanvas(STORY_MAX_ZOOM)} onOrganize={windowWidth >= 768 ? organize : undefined} organizeDisabled={!canOrganize} onUndoOrganize={canOrganize && previousArrangement?.key === arrangementKey ? undoOrganize : undefined} />}

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
          note={!runView && composerState.kind === 'ready' && routine ? <RoutineNote schedule={routine} onRunNow={() => void runRoutineNow()} busy={routineBusy} /> : undefined}
          mode={doc.mode} stepCount={doc.pipelineSteps.length || doc.nodes.length} anomalyCount={anomalies.length} state={composerState}
          value={composerText} onChange={setComposerText} onSubmit={() => void submit()} onStop={() => void stop()} onRetry={retry} onNewRun={() => void submit()}
          followUpStages={followUpStages} followUpTarget={followUpTarget} onFollowUpTargetChange={setFollowUpTarget}
          onFollowUp={runView && activeRunId ? () => void followUp() : undefined}
          switchBanner={doc.modeSwitchBanner}
        />
        {/* Opened from the menu on every screen (ADR 0043), so it is the shell's, not the
            composer's: Build hides the composer, and the drawer with it. */}
        {historyOpen && (
          <RunHistory entries={historyEntries} currentId={activeRunId} loading={!history.loaded} error={history.error ?? history.unavailable} onOpen={(entry) => {
            setHistoryOpen(false)
            if (entry.teamPath && entry.teamPath !== doc.path) window.location.assign(historyRunUrl(entry))
            else showRun(entry.id)
          }} onClose={() => setHistoryOpen(false)} />
        )}

        {paletteOpen && <CommandPalette actions={actions} interpret={interpret} fallback={askFallback} onClose={() => setPaletteOpen(false)} />}
        {discardConfirm && <InlineConfirm message="Discard changes and reload from disk?" confirmLabel="Discard changes" onConfirm={() => { setDiscardConfirm(false); void doc.reloadFromDisk() }} onCancel={() => setDiscardConfirm(false)} />}
        {pendingNodeDelete.length > 0 && <InlineConfirm message={`Delete ${pendingNodeDelete.length === 1 ? `${nodeNames.has(pendingNodeDelete[0]) ? `“${nodeNames.get(pendingNodeDelete[0])}”` : 'this card'} and its connections` : `${pendingNodeDelete.length} cards and their connections`}?`} confirmLabel="Delete" onConfirm={() => { deleteNodes(pendingNodeDelete); setPendingNodeDelete([]) }} onCancel={() => setPendingNodeDelete([])} />}
        {openPathOpen && <OpenTeamSheet onClose={() => setOpenPathOpen(false)} />}
        {newTeamSheet && <NewTeamSheet harnesses={harnesses} openTeamUnsaved={['dirty', 'invalid', 'conflict'].includes(doc.documentChipState)} onClose={() => setNewTeamSheet(false)} onCreateBlank={(name, path) => { doc.createNewDocument(name, path); setNewTeamSheet(false); showRun(null); onDocumentOpen() }} />}
        {saveCopyOpen && <SaveCopySheet error={doc.saveError} onClose={() => setSaveCopyOpen(false)} onSave={doc.saveCopy} />}
        {/* Home, not the deleted team's empty canvas, is where the operator goes next. */}
        {deleteTeamOpen && doc.path && <DeleteTeamDialog path={doc.path} name={doc.teamName ?? (doc.path.split('/').pop() ?? doc.path).replace(/\.ya?ml$/i, '')} onDeleted={() => window.location.assign('/')} onClose={() => setDeleteTeamOpen(false)} />}
        {yamlOpen && <YamlSheet title={yamlHighlightLine ? `YAML preview · line ${yamlHighlightLine}` : 'YAML preview'} yaml={doc.yamlPreview} highlightLine={yamlHighlightLine} onClose={() => { setYamlOpen(false); setYamlHighlightLine(null) }} />}
        {compareOpen && doc.externalChange && (
          <YamlSheet title="Disk ↔ in-memory YAML" yaml={unifiedYamlDiff(doc.externalChange.diskYaml, doc.yamlPreview)} onClose={() => setCompareOpen(false)} footer={<ConflictSheetFooter onKeepMine={doc.keepMine} onUseDisk={() => void doc.useDisk()} />} />
        )}
      </div>
    </CanvasActionsContext.Provider>
  )
}
