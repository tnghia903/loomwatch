import { Background, Controls, ReactFlow, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo } from 'react'

import { useTeamDocument } from '../lib/team-file/useTeamDocument'
import { AgentNodeCard } from './canvas/AgentNodeCard'
import { CanvasActionsContext, type CanvasActions } from './canvas/CanvasActionsContext'
import { ConfiguredEdgeView } from './canvas/ConfiguredEdgeView'
import { DocumentChip } from './canvas/DocumentChip'
import { EdgeRefusalPopover } from './canvas/EdgeRefusalPopover'
import { EntrypointProblemBar } from './canvas/EntrypointProblemBar'
import { Inspector } from './canvas/Inspector'
import { LIBRARY_DRAG_MIME } from './library'

const nodeTypes = { agent: AgentNodeCard }
const edgeTypes = { configured: ConfiguredEdgeView }

export function Canvas() {
  const doc = useTeamDocument()
  const { screenToFlowPosition } = useReactFlow()

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const raw = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
      if (!raw) {
        // Not a Library drag (e.g. an OS file drop) — leave it alone, §4.5 step 5.
        return
      }
      event.preventDefault()
      const dropPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      doc.addAgentFromDrop(raw, dropPosition)
    },
    [doc, screenToFlowPosition],
  )

  // ⌘S saves from anywhere, including while an input is focused (§9.1).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void doc.save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doc])

  const actions: CanvasActions = useMemo(
    () => ({ renameAgent: doc.renameAgent }),
    [doc.renameAgent],
  )

  const selectedNodes = doc.nodes.filter((node) => node.selected)
  const selectedEdges = doc.edges.filter((edge) => edge.selected)
  const inspectedNode =
    selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0] : null

  return (
    <CanvasActionsContext.Provider value={actions}>
      <ReactFlow
        nodes={doc.nodes}
        edges={doc.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={doc.onNodesChange}
        onEdgesChange={doc.onEdgesChange}
        onConnect={doc.onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        deleteKeyCode={['Backspace', 'Delete']}
        snapToGrid
        snapGrid={[8, 8]}
        minZoom={0.25}
        maxZoom={2}
        fitView
      >
        <Background />
        <Controls />
        {doc.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-md border border-dashed border-hairline/20 px-4 py-3 text-[13px] text-ink-3">
              Drag an agent from the Library to add it here.
            </p>
          </div>
        )}
      </ReactFlow>

      <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex flex-col items-center gap-2">
        <DocumentChip
          path={doc.path}
          saveState={doc.saveState}
          saveError={doc.saveError}
          entrypointProblem={doc.entrypointProblem}
          onSave={doc.save}
        />
        {doc.entrypointProblem && doc.entrypointProblem.candidates.length > 0 && (
          <EntrypointProblemBar problem={doc.entrypointProblem} onPromote={doc.promoteEntrypoint} />
        )}
      </div>

      {inspectedNode && (
        <div className="pointer-events-none absolute inset-y-4 right-4 z-10 flex items-start">
          <Inspector
            node={inspectedNode}
            isEntrypoint={inspectedNode.id === doc.entrypoint}
            onRename={(field, value) => doc.renameAgent(inspectedNode.id, field, value)}
            onModelChange={(value) => doc.updateAgentModel(inspectedNode.id, value)}
            onCwdChange={(value) => doc.updateAgentCwd(inspectedNode.id, value)}
            onBudgetChange={(limitUsd) => doc.updateAgentBudget(inspectedNode.id, limitUsd)}
            onAllowRecruitingChange={(allow) => doc.updateAgentAllowRecruiting(inspectedNode.id, allow)}
            onPromoteEntrypoint={() => doc.promoteEntrypoint(inspectedNode.id)}
            onDelete={() => doc.removeAgent(inspectedNode.id)}
            onClose={() => doc.onNodesChange([{ id: inspectedNode.id, type: 'select', selected: false }])}
          />
        </div>
      )}

      {doc.refusal && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-20 flex justify-center">
          <EdgeRefusalPopover
            refusal={doc.refusal}
            onPromote={(id) => doc.promoteEntrypoint(id)}
            onDismiss={doc.dismissRefusal}
          />
        </div>
      )}
    </CanvasActionsContext.Provider>
  )
}
