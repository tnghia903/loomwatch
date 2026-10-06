import type { ReactFlowInstance } from '@xyflow/react'
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import type { CapabilityEdgeConfig, CapabilityNodeConfig } from '../../lib/composer-layout/types'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { useRunSession } from '../../lib/runs/useRunSession'
import type { ConfiguredEdge, useTeamDocument } from '../../lib/team-file/useTeamDocument'
import { setThemeMode, type ResolvedTheme } from '../../lib/theme'
import type { InspectedCapability } from '../canvas/CapabilityInspector'
import type { LayerSolo } from '../canvas/LayerLegend'

type TeamDocument = ReturnType<typeof useTeamDocument>
type RunSession = ReturnType<typeof useRunSession>
type Setter<T> = Dispatch<SetStateAction<T>>

/** What the workspace's keyboard shortcuts read and act on, as of the latest render. */
export interface WorkspaceShortcutContext {
  editable: boolean
  doc: Pick<TeamDocument, 'nodes' | 'edges' | 'pipelineSteps' | 'refusal' | 'save' | 'reloadFromDisk' | 'undo' | 'redo' | 'dismissRefusal' | 'onNodesChange' | 'onEdgesChange'>
  flow: Pick<ReactFlowInstance, 'fitView' | 'setViewport' | 'zoomIn' | 'zoomOut'>
  theme: ResolvedTheme
  windowWidth: number
  runView: boolean
  /** The edge-layer legend is on screen, so `L` may cycle the solo layer. */
  layersVisible: boolean
  session: Pick<RunSession, 'terminal' | 'lastSeq' | 'cursor' | 'setCursor'>
  submit: () => Promise<void>
  openNewTeam: () => void
  toggleLibrary: () => void
  cycleProblem: (direction: 1 | -1) => void
  clearSelection: () => void
  closeRun: () => void
  /** Details open beside the team's chat (ADR 0051): Esc closes it, live work or not, and keeps the chat. */
  closeDetails?: () => void
  organize: () => void
  fitCanvas: () => void
  // Esc unwinds these, deepest disclosure first.
  pendingNodeDelete: string[]
  setPendingNodeDelete: Setter<string[]>
  requestNodeDelete: (ids: readonly string[]) => void
  deleteNodes: (ids: readonly string[]) => void
  discardConfirm: boolean
  setDiscardConfirm: Setter<boolean>
  paletteOpen: boolean
  setPaletteOpen: Setter<boolean>
  problemsOpen: boolean
  setProblemsOpen: Setter<boolean>
  yamlOpen: boolean
  setYamlOpen: Setter<boolean>
  compareOpen: boolean
  setCompareOpen: Setter<boolean>
  inspectedEvidenceId: string | null
  setInspectedEvidenceId: Setter<string | null>
  handoverAgentId: string | null
  setHandoverAgentId: Setter<string | null>
  inspectedCapability: InspectedCapability | null
  provenanceOpen: boolean
  setProvenanceOpen: Setter<boolean>
  memoryOpen: boolean
  setMemoryOpen: Setter<boolean>
  fannedAgentId: string | null
  setFannedAgentId: Setter<string | null>
  setSolo: Setter<LayerSolo>
  setSweeping: Setter<boolean>
  // Selection, for Esc and Delete.
  selectedNodes: readonly AgentNode[]
  selectedEdges: readonly ConfiguredEdge[]
  selectedCapabilities: ReadonlySet<string>
  selectedCapabilityEdgeIds: ReadonlySet<string>
  capabilityCards: readonly CapabilityNodeConfig[]
  capabilityEdgeById: ReadonlyMap<string, CapabilityEdgeConfig>
  removeCapabilityCards: (ids: readonly string[]) => void
  removeCapabilityEdge: (source: string, target: string) => void
}

/**
 * The workspace's global keyboard shortcuts.
 *
 * One `keydown` listener for the life of the workspace, reading the context of the latest commit
 * through a ref. The ref is written in a passive effect, the same moment the previous
 * implementation re-subscribed, so a key always sees exactly what it saw before — but there is
 * no dependency list to fall out of step with the handler, which is where stale closures came from.
 */
export function useWorkspaceShortcuts(context: WorkspaceShortcutContext) {
  const latest = useRef(context)
  useEffect(() => { latest.current = context })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleWorkspaceKey(event, latest.current)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function handleWorkspaceKey(event: KeyboardEvent, context: WorkspaceShortcutContext) {
  const {
    editable, doc, flow, theme, windowWidth, runView, layersVisible, session, submit, openNewTeam,
    toggleLibrary, cycleProblem, clearSelection, closeRun, closeDetails, organize, fitCanvas, pendingNodeDelete,
    setPendingNodeDelete, requestNodeDelete, deleteNodes, discardConfirm, setDiscardConfirm, paletteOpen,
    setPaletteOpen, problemsOpen, setProblemsOpen,
    yamlOpen, setYamlOpen, compareOpen, setCompareOpen, inspectedEvidenceId, setInspectedEvidenceId,
    handoverAgentId, setHandoverAgentId, inspectedCapability, provenanceOpen, setProvenanceOpen, memoryOpen,
    setMemoryOpen, fannedAgentId, setFannedAgentId, setSolo, setSweeping, selectedNodes, selectedEdges,
    selectedCapabilities, selectedCapabilityEdgeIds, capabilityCards, capabilityEdgeById,
    removeCapabilityCards, removeCapabilityEdge
  } = context
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    const editingText = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)
    if (mod && key === 'k') { event.preventDefault(); setPaletteOpen(true); return }
    if (mod && key === 's') { event.preventDefault(); if (editable) void doc.save(); return }
    if (mod && event.shiftKey && key === 'l') { event.preventDefault(); setSweeping(true); window.setTimeout(() => setSweeping(false), 340); setThemeMode(theme === 'dark' ? 'light' : 'dark'); return }
    if (mod && key === 'n') { event.preventDefault(); openNewTeam(); return }
    // §1.2: ⌘↵ submits from anywhere in the app, including a focused canvas — above the
    // `editingText` guard below, which would otherwise swallow it in every other field. The
    // composer's own textarea binds it directly (there it also serves Retry and New run), so
    // it is skipped here rather than submitted twice.
    if (mod && event.key === 'Enter') {
      if (!(event.target instanceof HTMLElement && event.target.closest('.lw-composer, .tc-composer'))) { event.preventDefault(); void submit() }
      return
    }
    if (event.key === 'F8') { event.preventDefault(); cycleProblem(event.shiftKey ? -1 : 1); return }
    if (event.key === 'Escape') {
      if (pendingNodeDelete.length > 0) setPendingNodeDelete([])
      else if (discardConfirm) setDiscardConfirm(false)
      else if (paletteOpen) setPaletteOpen(false)
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
      else if (closeDetails) closeDetails()
      else if (runView && session.terminal) closeRun()
      return
    }
    if (editingText) return
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) doc.redo(); else doc.undo(); return }
    if (mod && key === '\\') { event.preventDefault(); if (windowWidth >= 768) toggleLibrary(); return }
    if (mod && key === '0') { event.preventDefault(); void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 }); return }
    if (mod && (key === '+' || key === '=')) { event.preventDefault(); void flow.zoomIn({ duration: 200 }); return }
    if (mod && key === '-') { event.preventDefault(); void flow.zoomOut({ duration: 200 }); return }
    if (event.altKey && mod && optionLetter(event, 'l')) { event.preventDefault(); organize(); return }
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

/**
 * Whether an Option (Alt) chord presses `letter`. Option changes the character a key types: on
 * macOS ⌥L reports `key: '¬'`, and AltGr+L types `ł` on Polish layouts. When the layout no longer
 * reports a plain letter, the physical key decides; while it still does (Colemak's L, which sits on
 * QWERTY's U), `event.key` decides, as it does for every other shortcut here.
 */
function optionLetter(event: KeyboardEvent, letter: string) {
  const key = event.key.toLowerCase()
  return /^[a-z]$/.test(key) ? key === letter : event.code === `Key${letter.toUpperCase()}`
}
