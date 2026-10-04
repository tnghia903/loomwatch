import { createContext, useContext, useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, Handle, Position, MarkerType, type Node, type NodeProps, type Edge } from '@xyflow/react'
import { Bot, CheckCircle2, CircleAlert, Code2, Puzzle, Wrench } from 'lucide-react'
import type { RunCapability } from '../../lib/runs/capabilityEvidence'

type Capability = RunCapability & { agentId: string; agentName: string }
type AgentData = { agentId: string }
type CapabilityData = { itemId: string }
type GraphView = { items: ReadonlyMap<string, Capability>; harnesses: ReadonlyMap<string, string>; planned: boolean; scoped: boolean; onInspect: (item: Capability) => void; buttonRef: (id: string, element: HTMLButtonElement | null) => void }
/**
 * What the nodes show. React Flow forgets a node's measured size each time it is handed a new node
 * object, and when that lands between its measuring the node and committing it, the node stays
 * `visibility: hidden` for good — the Editor graph went blank mid-run (2026-10-05). A live run
 * re-renders this graph on every event and relabels its calls as they come in, so the node objects
 * depend on the layout alone and everything that changes as the run goes reaches them through here.
 */
const GraphViewContext = createContext<GraphView | null>(null)
function GraphAgent({ data }: NodeProps<Node<AgentData>>) {
  const view = useContext(GraphViewContext)
  const owner = [...(view?.items.values() ?? [])].find(item => item.agentId === data.agentId)
  if (!view || !owner) return null
  return <div className="graph-agent"><Bot size={19} /><div><strong>{owner.agentName}</strong><small><Code2 size={12} />{view.harnesses.get(data.agentId) ?? 'Not recorded'}</small></div><Handle type="source" position={Position.Right} isConnectable={false} /></div>
}
function GraphCapability({ data }: NodeProps<Node<CapabilityData>>) {
  const view = useContext(GraphViewContext)
  const item = view?.items.get(data.itemId)
  if (!view || !item) return null
  const { planned } = view
  const Icon = item.kind === 'skill' ? Puzzle : Wrench
  return <button className={`graph-capability nodrag nopan ${item.kind} state-${item.state}`} ref={element => view.buttonRef(item.id, element)} onClick={() => view.onInspect(item)} aria-label={`Inspect ${item.name}: ${planned && item.required ? 'Will load' : item.label}${view.scoped ? ` · ${item.agentName}` : ''}`}><Handle type="target" position={Position.Left} isConnectable={false} /><Icon size={18} /><span className="graph-capability-copy"><strong>{item.name}{item.required && <span className="required-mini">Required</span>}</strong><small>{item.state === 'loaded' || item.state === 'observed' ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}{planned && item.required ? 'Will load' : item.label}</small></span></button>
}
const nodeTypes = { capabilityAgent: GraphAgent, capabilityItem: GraphCapability }
export function CapabilityGraph({ items, harnesses, planned, scoped, onInspect, buttonRef }: { items: Capability[]; harnesses: ReadonlyMap<string,string>; planned: boolean; scoped: boolean; onInspect: (item: Capability) => void; buttonRef: GraphView['buttonRef'] }) {
  // Which items, whose, in what order: the only inputs that move a node. A string, so an unchanged
  // layout keeps the very same node objects however often the run re-renders.
  const layoutKey = JSON.stringify(items.map(item => [item.agentId, item.id]))
  const layout = useMemo(() => {
    const placed = JSON.parse(layoutKey) as [string, string][]
    const nodes: Node[] = []
    let offset = 0
    for (const agentId of new Set(placed.map(([owner]) => owner))) {
      const owned = placed.filter(([owner]) => owner === agentId)
      const height = Math.max(96, owned.length * 87)
      nodes.push({ id: agentId, type: 'capabilityAgent', position: { x: 10, y: offset + (height - 58) / 2 }, data: { agentId } })
      owned.forEach(([, itemId], i) => nodes.push({ id: `${agentId}:${itemId}`, type: 'capabilityItem', position: { x: 343, y: offset + i * 87 }, data: { itemId } }))
      offset += height + 34
    }
    return { nodes, height: Math.max(305, offset + 30) }
  }, [layoutKey])
  // Edges carry no measurements, so they can follow each item's state directly.
  const edges = useMemo(() => items.map((item): Edge => ({ id: `${item.agentId}:${item.id}:edge`, source: item.agentId, target: `${item.agentId}:${item.id}`, type: 'smoothstep', label: item.required ? item.state === 'loaded' ? 'loaded' : item.state === 'read' ? 'read' : 'requires' : 'called', markerEnd: { type: MarkerType.ArrowClosed, color: '#67666c', width: 12, height: 12 }, style: { stroke: '#67666c', strokeWidth: 1.25, strokeDasharray: planned || item.state === 'unverified' ? '4 4' : undefined }, labelStyle: { fill: '#b2b1b7', fontSize: 11 }, labelBgStyle: { fill: '#0e1012' } })), [items, planned])
  const view = useMemo(() => ({ items: new Map(items.map(item => [item.id, item])), harnesses, planned, scoped, onInspect, buttonRef }), [items, harnesses, planned, scoped, onInspect, buttonRef])
  return <div className={`capability-graph ${scoped ? 'whole-team' : ''}`} aria-label="Agent skills and tools graph" style={{ height: layout.height }}><GraphViewContext.Provider value={view}><ReactFlowProvider><ReactFlow key={layoutKey} nodes={layout.nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.35} maxZoom={1.2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }} /></ReactFlowProvider></GraphViewContext.Provider></div>
}
