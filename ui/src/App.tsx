import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

const nodes: Node[] = [
  { id: 'researcher', position: { x: 0, y: 80 }, data: { label: 'researcher' } },
  { id: 'reviewer', position: { x: 260, y: 80 }, data: { label: 'reviewer' } },
]

const edges: Edge[] = [{ id: 'researcher-reviewer', source: 'researcher', target: 'reviewer' }]

function App() {
  return (
    <div className="h-screen w-screen bg-neutral-50">
      <header className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
        <div className="pointer-events-auto rounded-lg border border-neutral-200 bg-white/90 px-4 py-2 text-center shadow-sm backdrop-blur">
          <h1 className="text-sm font-semibold text-neutral-900">LoomWatch</h1>
          <p className="text-xs text-neutral-500">
            Phase 04 scaffold — the canvas arrives in a later issue
          </p>
        </div>
      </header>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

export default App
