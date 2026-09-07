import { Background, Controls, ReactFlow, useNodesState, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback } from 'react'

import { type AgentNode, nodeFromDrop } from '../lib/library/nodeFromDrop'
import { LIBRARY_DRAG_MIME } from './library'

export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>([])
  const { screenToFlowPosition } = useReactFlow()

  // Accepting the drop requires calling preventDefault on dragover too (HTML5 DnD).
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
      const newNode = nodeFromDrop(raw, dropPosition, nodes)
      if (!newNode) {
        return
      }

      setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), newNode])
    },
    [nodes, screenToFlowPosition, setNodes],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      onNodesChange={onNodesChange}
      onDragOver={onDragOver}
      onDrop={onDrop}
      snapToGrid
      snapGrid={[8, 8]}
      fitView
    >
      <Background />
      <Controls />
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-dashed border-hairline/20 px-4 py-3 text-[13px] text-ink-3">
            Drag an agent from the Library to add it here.
          </p>
        </div>
      )}
    </ReactFlow>
  )
}
