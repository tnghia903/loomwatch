import { Background, Controls, MiniMap, ReactFlow, useReactFlow, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useTeamDocument } from '../lib/team-file/useTeamDocument'
import { unifiedYamlDiff } from '../lib/team-file/diff'
import { AgentNodeCard } from './canvas/AgentNodeCard'
import { CanvasActionsContext, type CanvasActions } from './canvas/CanvasActionsContext'
import { CommandPalette, type CommandAction } from './canvas/CommandPalette'
import { ConfiguredEdgeView } from './canvas/ConfiguredEdgeView'
import { ConflictBar } from './canvas/ConflictBar'
import { DocumentChip } from './canvas/DocumentChip'
import { EdgeRefusalPopover } from './canvas/EdgeRefusalPopover'
import { EntrypointProblemBar } from './canvas/EntrypointProblemBar'
import { Inspector } from './canvas/Inspector'
import { ModePill } from './canvas/ModePill'
import { ParseFailureModal } from './canvas/ParseFailureModal'
import { YamlSheet } from './canvas/YamlSheet'
import { LIBRARY_DRAG_MIME } from './library'

const nodeTypes = { agent: AgentNodeCard }
const edgeTypes = { configured: ConfiguredEdgeView }

interface CanvasProps {
  harnessCount: number
  harnessesLoading: boolean
  libraryVisible: boolean
  onToggleLibrary: () => void
  onDocumentOpen: () => void
}

interface Guides { vertical?: number; horizontal?: number }

const NODE_WIDTH = 264
const NODE_HEIGHT = 88
const GUIDE_THRESHOLD = 4

function nodeBounds(node: Node) {
  const width = node.measured?.width ?? NODE_WIDTH
  const height = node.measured?.height ?? NODE_HEIGHT
  return {
    left: node.position.x,
    right: node.position.x + width,
    centreX: node.position.x + width / 2,
    top: node.position.y,
    bottom: node.position.y + height,
    centreY: node.position.y + height / 2,
  }
}

/** §7.2: guide when either centre or either edge is within four pixels. */
function matchingGuide(dragged: Node, otherNodes: readonly Node[]) {
  const bounds = nodeBounds(dragged)
  const verticalCandidates = [bounds.centreX, bounds.left, bounds.right]
  const horizontalCandidates = [bounds.centreY, bounds.top, bounds.bottom]
  let vertical: number | undefined
  let horizontal: number | undefined

  for (const other of [...otherNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const otherBounds = nodeBounds(other)
    if (vertical === undefined) {
      vertical = [otherBounds.centreX, otherBounds.left, otherBounds.right]
        .find((target) => verticalCandidates.some((candidate) => Math.abs(candidate - target) <= GUIDE_THRESHOLD))
    }
    if (horizontal === undefined) {
      horizontal = [otherBounds.centreY, otherBounds.top, otherBounds.bottom]
        .find((target) => horizontalCandidates.some((candidate) => Math.abs(candidate - target) <= GUIDE_THRESHOLD))
    }
    if (vertical !== undefined && horizontal !== undefined) break
  }

  return { vertical, horizontal }
}

export function Canvas({ harnessCount, harnessesLoading, libraryVisible, onToggleLibrary, onDocumentOpen }: CanvasProps) {
  const doc = useTeamDocument()
  const flow = useReactFlow()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [minimapOpen, setMinimapOpen] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [openPathOpen, setOpenPathOpen] = useState(false)
  const [openPath, setOpenPath] = useState('')
  const [newTeamSheet, setNewTeamSheet] = useState(false)
  const [guides, setGuides] = useState<Guides>({})
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [oneNodeHint, setOneNodeHint] = useState(false)
  const editable = !doc.readOnlyReason && windowWidth >= 768

  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    if (doc.path && doc.nodes.length === 1 && doc.edges.length === 0 && !localStorage.getItem('loomwatch:one-node-hint')) {
      localStorage.setItem('loomwatch:one-node-hint', 'shown')
      const showTimer = window.setTimeout(() => setOneNodeHint(true), 0)
      const hideTimer = window.setTimeout(() => setOneNodeHint(false), 6000)
      return () => { window.clearTimeout(showTimer); window.clearTimeout(hideTimer) }
    }
  }, [doc.path, doc.nodes.length, doc.edges.length])

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!editable || !event.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [editable])

  const onDrop = useCallback((event: React.DragEvent) => {
    if (!editable) return
    const raw = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
    if (!raw) return
    event.preventDefault()
    doc.addAgentFromDrop(raw, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [doc, flow, editable])

  const fitSelection = useCallback(() => {
    const selected = doc.nodes.filter((node) => node.selected)
    if (selected.length > 0) void flow.fitView({ nodes: selected, padding: 0.2, maxZoom: 1, duration: 300 })
  }, [doc.nodes, flow])

  const actions = useMemo<CommandAction[]>(() => [
    { label: 'Add agent…', run: onToggleLibrary, disabled: !doc.path || !editable },
    { label: 'Save', shortcut: '⌘S', run: () => void doc.save(), disabled: !doc.path || !editable || !doc.isValid },
    { label: 'Open team…', run: () => { setOpenPath(''); setOpenPathOpen(true) } },
    { label: 'New team…', run: () => {
      setNewName('')
      if (doc.path) setNewTeamSheet(true)
      else setCreating(true)
    } },
    { label: 'Reload from disk', run: () => void doc.reloadFromDisk(), disabled: !doc.path || doc.saveState === 'new' },
    { label: 'Fit view', shortcut: 'F', run: () => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }) },
    { label: 'Auto-layout', shortcut: '⌥⌘L', run: doc.layoutNodes, disabled: !editable },
    { label: libraryVisible ? 'Hide library' : 'Show library', shortcut: '⌘\\', run: onToggleLibrary, disabled: !doc.path },
    { label: 'Toggle minimap', run: () => setMinimapOpen((open) => !open) },
    { label: 'Toggle theme', run: () => document.documentElement.classList.toggle('dark') },
    { label: 'Copy file path', run: () => { if (doc.path) void navigator.clipboard?.writeText(doc.path) }, disabled: !doc.path },
    { label: 'Show YAML', run: () => setYamlOpen(true), disabled: !doc.path },
  ], [doc, editable, flow, libraryVisible, onToggleLibrary])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && key === 'k') { event.preventDefault(); setPaletteOpen(true); return }
      if (mod && key === 's') { event.preventDefault(); if (editable) void doc.save(); return }
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) doc.redo(); else doc.undo(); return }
      if (mod && key === '\\') { event.preventDefault(); onToggleLibrary(); return }
      if (mod && key === '0') { event.preventDefault(); void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 }); return }
      if (mod && (key === '+' || key === '=')) { event.preventDefault(); void flow.zoomIn({ duration: 200 }); return }
      if (mod && key === '-') { event.preventDefault(); void flow.zoomOut({ duration: 200 }); return }
      if (event.altKey && mod && key === 'l') { event.preventDefault(); if (editable) doc.layoutNodes(); return }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else if (yamlOpen) setYamlOpen(false)
        else if (compareOpen) setCompareOpen(false)
        else if (doc.refusal) doc.dismissRefusal()
        else {
          doc.onNodesChange(doc.nodes.filter((node) => node.selected).map((node) => ({ id: node.id, type: 'select' as const, selected: false })))
          doc.onEdgesChange(doc.edges.filter((edge) => edge.selected).map((edge) => ({ id: edge.id, type: 'select' as const, selected: false })))
        }
        return
      }
      if (event.key === 'Tab' && doc.nodes.length > 0) {
        event.preventDefault()
        const orderedIds = doc.pipelineSteps.length > 0 ? doc.pipelineSteps.map((step) => step.id) : doc.nodes.map((node) => node.id)
        const currentIndex = orderedIds.findIndex((id) => doc.nodes.some((node) => node.id === id && node.selected))
        const offset = event.shiftKey ? -1 : 1
        const nextId = orderedIds[(currentIndex + offset + orderedIds.length) % orderedIds.length]
        doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: node.id === nextId })))
        const next = doc.nodes.find((node) => node.id === nextId)
        if (next) void flow.fitView({ nodes: [next], padding: 0.6, maxZoom: 1, duration: 200 })
        return
      }
      if (event.key === 'Enter') {
        const selected = doc.nodes.find((node) => node.selected)
        if (selected && editable) window.dispatchEvent(new CustomEvent('loomwatch:rename-agent', { detail: { id: selected.id } }))
        return
      }
      if (key === 'f') {
        event.preventDefault()
        if (event.shiftKey) fitSelection()
        else void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doc, editable, fitSelection, flow, onToggleLibrary, paletteOpen, yamlOpen, compareOpen])

  const stepById = useMemo(() => new Map(doc.pipelineSteps.map((step) => [step.id, step])), [doc.pipelineSteps])
  const nodeNames = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node.data.label])), [doc.nodes])
  const canvasActions: CanvasActions = useMemo(
    () => ({ renameAgent: doc.renameAgent, touchField: doc.touchField, mode: doc.mode, stepById, nodeNames }),
    [doc.renameAgent, doc.touchField, doc.mode, stepById, nodeNames],
  )
  const selectedNodes = doc.nodes.filter((node) => node.selected)
  const selectedEdges = doc.edges.filter((edge) => edge.selected)
  const inspectedNode = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : null

  const onNodeDrag = useCallback((_event: MouseEvent | TouchEvent, dragged: Node) => {
    const others = doc.nodes.filter((node) => node.id !== dragged.id)
    const guide = matchingGuide(dragged, others)
    setGuides({
      vertical: guide.vertical === undefined ? undefined : flow.flowToScreenPosition({ x: guide.vertical, y: 0 }).x,
      horizontal: guide.horizontal === undefined ? undefined : flow.flowToScreenPosition({ x: 0, y: guide.horizontal }).y,
    })
  }, [doc.nodes, flow])

  if (!doc.path && !doc.loadFailure) {
    return (
      <FirstRun
        harnessCount={harnessCount}
        loading={harnessesLoading}
        creating={creating}
        name={newName}
        onNameChange={setNewName}
        onStart={() => setCreating(true)}
        onCancel={() => setCreating(false)}
        onCreate={() => { doc.createNewDocument(newName); onDocumentOpen() }}
        onOpen={() => { setOpenPath(''); setOpenPathOpen(true) }}
        onPalette={() => setPaletteOpen(true)}
      >
        {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
        {openPathOpen && <OpenTeamSheet path={openPath} onPathChange={setOpenPath} onClose={() => setOpenPathOpen(false)} />}
      </FirstRun>
    )
  }

  return (
    <CanvasActionsContext.Provider value={canvasActions}>
      <div role="application" aria-label="Team canvas" className="absolute inset-0">
        <ReactFlow
          nodes={doc.nodes}
          edges={doc.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={doc.onNodesChange}
          onEdgesChange={doc.onEdgesChange}
          onConnect={editable ? doc.onConnect : undefined}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onNodeDragStart={doc.capturePositionHistory}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={(_event, node) => { setGuides({}); doc.settleNodeCollision(node.id) }}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={editable}
          nodesFocusable
          edgesFocusable
          snapToGrid
          snapGrid={[8, 8]}
          minZoom={0.25}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        >
          <Background variant={'dots' as never} gap={16} size={1} color="var(--color-canvas-dot)" />
          <Controls />
          {minimapOpen && <MiniMap pannable zoomable nodeColor="var(--color-ink-3)" />}
          {doc.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="flex h-[88px] w-[264px] items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-hairline/20 text-center text-[13px] text-ink-3">Drag an agent here<br />from the left</div>
            </div>
          )}
          {oneNodeHint && doc.nodes[0] && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-36 text-[12px] text-ink-3">Drag from the right edge of a node to sequence another after it.</div>
          )}
        </ReactFlow>
      </div>

      {guides.vertical !== undefined && <div className="pointer-events-none fixed inset-y-0 z-20 w-px bg-iris" style={{ left: guides.vertical }} />}
      {guides.horizontal !== undefined && <div className="pointer-events-none fixed inset-x-0 z-20 h-px bg-iris" style={{ top: guides.horizontal }} />}

      <div aria-live="polite" className="sr-only">{doc.diskNotice ?? (doc.modeSwitchBanner ? 'Team changed to pipeline mode.' : '')}</div>
      <div aria-live="assertive" className="sr-only">{doc.externalChange ? 'The team file changed on disk.' : doc.refusal?.message ?? ''}</div>

      {doc.externalChange && <div className="absolute inset-x-0 top-0 z-30"><ConflictBar filename={doc.path?.split('/').pop() ?? 'Team file'} onKeepMine={doc.keepMine} onUseDisk={() => void doc.useDisk()} onCompare={() => setCompareOpen(true)} /></div>}

      <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex flex-col items-center gap-2">
        <DocumentChip path={doc.path} saveState={doc.documentChipState} saveError={doc.saveError} entrypointProblem={doc.entrypointProblem} documentProblems={doc.documentProblems} fieldProblemCount={Array.from(doc.fieldProblemsByAgent.values()).reduce((count, fields) => count + Object.keys(fields).length, 0)} isValid={doc.isValid} readOnlyReason={doc.readOnlyReason} editingDisabled={windowWidth < 768} onSave={doc.save} onReload={doc.reloadFromDisk} onShowYaml={() => setYamlOpen(true)} />
        {doc.diskNotice && <p className="rounded-md bg-surface-solid px-2 py-1 text-[12px] text-ink-2">{doc.diskNotice}</p>}
        {doc.entrypointProblem && doc.entrypointProblem.candidates.length > 0 && editable && <EntrypointProblemBar problem={doc.entrypointProblem} onPromote={doc.promoteEntrypoint} />}
      </div>

      {inspectedNode && windowWidth < 1024 && <div className="absolute inset-0 z-20 bg-ink/10" />}
      {inspectedNode && <div className="canvas-inspector pointer-events-none absolute inset-y-4 right-4 z-30 flex items-start"><Inspector node={inspectedNode} isEntrypoint={inspectedNode.id === doc.entrypoint} fieldProblems={doc.fieldProblemsByAgent.get(inspectedNode.id)} readOnly={!editable} onFieldBlur={(field) => doc.touchField(inspectedNode.id, field)} onRename={(field, value) => doc.renameAgent(inspectedNode.id, field, value)} onModelChange={(value) => doc.updateAgentModel(inspectedNode.id, value)} onCwdChange={(value) => doc.updateAgentCwd(inspectedNode.id, value)} onBudgetChange={(value) => doc.updateAgentBudget(inspectedNode.id, value)} onAllowRecruitingChange={(value) => doc.updateAgentAllowRecruiting(inspectedNode.id, value)} onPromoteEntrypoint={() => doc.promoteEntrypoint(inspectedNode.id)} onDelete={() => doc.removeAgent(inspectedNode.id)} onClose={() => doc.onNodesChange([{ id: inspectedNode.id, type: 'select', selected: false }])} /></div>}

      {doc.refusal && <div className="pointer-events-none absolute inset-x-0 bottom-20 z-20 flex justify-center"><EdgeRefusalPopover refusal={doc.refusal} onPromote={doc.promoteEntrypoint} onDismiss={doc.dismissRefusal} /></div>}
      {doc.path && <div className="pointer-events-none absolute inset-x-0 bottom-[var(--canvas-bottom-offset,1rem)] z-10 flex justify-center"><ModePill mode={doc.mode} pipelineSteps={doc.pipelineSteps} nodeNames={nodeNames} entrypointName={doc.entrypoint ? nodeNames.get(doc.entrypoint) ?? doc.entrypoint : null} teamGuards={doc.teamGuards} teamBudget={doc.teamBudget} onUpdateGuards={doc.updateTeamGuards} onUpdateBudget={doc.updateTeamBudget} switchBanner={doc.modeSwitchBanner} pendingRemoval={doc.pendingEdgeRemoval} onKeepRemoval={doc.keepLastEdgeRemoval} onUndoRemoval={doc.undoLastEdgeRemoval} readOnly={!editable} /></div>}

      {paletteOpen && <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />}
      {openPathOpen && <OpenTeamSheet path={openPath} onPathChange={setOpenPath} onClose={() => setOpenPathOpen(false)} />}
      {newTeamSheet && <NewTeamSheet name={newName} onNameChange={setNewName} onClose={() => setNewTeamSheet(false)} onCreate={() => { doc.createNewDocument(newName); setNewTeamSheet(false); onDocumentOpen() }} />}
      {yamlOpen && <YamlSheet title="YAML preview" yaml={doc.yamlPreview} onClose={() => setYamlOpen(false)} />}
      {compareOpen && doc.externalChange && <YamlSheet title="Disk ↔ in-memory YAML" yaml={unifiedYamlDiff(doc.externalChange.diskYaml, doc.yamlPreview)} onClose={() => setCompareOpen(false)} />}
      {doc.loadFailure && <ParseFailureModal failure={doc.loadFailure} />}
    </CanvasActionsContext.Provider>
  )
}

function FirstRun({ harnessCount, loading, creating, name, onNameChange, onStart, onCancel, onCreate, onOpen, onPalette, children }: { harnessCount: number; loading: boolean; creating: boolean; name: string; onNameChange: (name: string) => void; onStart: () => void; onCancel: () => void; onCreate: () => void; onOpen: () => void; onPalette: () => void; children: React.ReactNode }) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-team'
  return (
    <div className="absolute inset-0 z-30 overflow-hidden bg-canvas">
      <div className="absolute inset-0 opacity-50" style={{ backgroundImage: 'radial-gradient(var(--color-canvas-dot) 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
      <main className="relative flex h-full items-center justify-center text-center">
        <div className="flex flex-col items-center">
          <svg viewBox="0 0 72 40" className="mb-5 h-10 w-[72px] text-iris" aria-label="LoomWatch woven mark"><path d="M2 20 12 6l10 14L32 6l10 14L52 6l18 28M2 20l10 14 10-14 10 14 10-14 10 14 18-28" fill="none" stroke="currentColor" strokeWidth="3" /></svg>
          {!creating ? <>
            <h1 className="text-[28px] font-semibold tracking-tight text-ink">LoomWatch</h1>
            <p className="mt-2 text-[14px] text-ink-2">Compose a team of agents. Watch them work.</p>
            <button type="button" onClick={onStart} className="mt-7 h-10 rounded-full bg-iris px-8 text-[14px] font-medium text-white">New team</button>
            <button type="button" onClick={onOpen} className="mt-3 text-[13px] text-ink-2 hover:text-iris">or open an existing team file</button>
          </> : <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate() }} onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}>
            <label className="flex items-center gap-3 text-[14px] text-ink-2">Name<input autoFocus value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Research and review" className="w-72 border-b border-iris bg-transparent px-2 py-2 text-[18px] text-ink outline-none" /></label>
            <p className="mt-3 font-mono text-[12px] text-ink-3">{slug}.yaml in ~/…/teams</p>
            <p className="mt-1 text-right text-[11px] text-ink-3">⏎ to create</p>
          </form>}
        </div>
      </main>
      <p className="absolute bottom-4 left-4 text-[12px] text-ink-3">{loading ? 'Looking for harnesses…' : harnessCount === 0 ? 'No agent harnesses found' : `${harnessCount} harness${harnessCount === 1 ? '' : 'es'} ready`}</p>
      <button type="button" onClick={onPalette} className="absolute bottom-4 right-4 font-mono text-[12px] text-ink-3">⌘K</button>
      {children}
    </div>
  )
}

function OpenTeamSheet({ path, onPathChange, onClose }: { path: string; onPathChange: (path: string) => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 bg-ink/10" onMouseDown={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (path.trim()) window.location.assign(`/?path=${encodeURIComponent(path.trim())}`) }} onMouseDown={(event) => event.stopPropagation()} className="mx-auto mt-[22vh] w-[min(480px,calc(100vw-32px))] rounded-xl border border-hairline/10 bg-surface-solid p-4 text-left shadow-[0_24px_80px_rgb(0_0_0/.2)]">
        <label className="text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">Open team path<input autoFocus value={path} onChange={(event) => onPathChange(event.target.value)} placeholder="research-team.yaml" className="mt-2 h-10 w-full rounded-md border border-hairline/10 bg-canvas px-3 font-mono text-[13px] normal-case tracking-normal text-ink outline-none focus:border-iris" /></label>
        <p className="mt-2 text-[12px] text-ink-3">Relative to the daemon teams directory.</p>
        <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-[13px] text-ink-2">Cancel</button><button type="submit" disabled={!path.trim()} className="rounded-full bg-iris px-4 py-1.5 text-[13px] text-white disabled:opacity-40">Open</button></div>
      </form>
    </div>
  )
}

function NewTeamSheet({ name, onNameChange, onClose, onCreate }: { name: string; onNameChange: (name: string) => void; onClose: () => void; onCreate: () => void }) {
  return (
    <div className="absolute inset-0 z-50 bg-ink/10" onMouseDown={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate() }} onMouseDown={(event) => event.stopPropagation()} className="mx-auto mt-[22vh] w-[min(480px,calc(100vw-32px))] rounded-xl border border-hairline/10 bg-surface-solid p-4 shadow-[0_24px_80px_rgb(0_0_0/.2)]">
        <label className="text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">New team name<input autoFocus value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Research and review" className="mt-2 h-10 w-full rounded-md border border-hairline/10 bg-canvas px-3 text-[14px] normal-case tracking-normal text-ink outline-none focus:border-iris" /></label>
        <p className="mt-2 text-[12px] text-copper">Creating a new document replaces the current in-memory canvas.</p>
        <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-[13px] text-ink-2">Cancel</button><button type="submit" disabled={!name.trim()} className="rounded-full bg-iris px-4 py-1.5 text-[13px] text-white disabled:opacity-40">Create</button></div>
      </form>
    </div>
  )
}
