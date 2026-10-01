import { useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, Handle, Position, MarkerType, type Node, type NodeProps, type Edge } from '@xyflow/react'
import { Bot, CheckCircle2, CircleAlert, Code2, Puzzle, Wrench } from 'lucide-react'
import type { RunCapability } from '../../lib/runs/capabilityEvidence'

type Capability = RunCapability & { agentId: string; agentName: string }
type AgentData = { name: string; harness: string }
type CapabilityData = { item: Capability; planned: boolean; onInspect: (item: Capability) => void; buttonRef: (id: string, element: HTMLButtonElement | null) => void; scoped: boolean }
function GraphAgent({ data }: NodeProps<Node<AgentData>>) {
  return <div className="graph-agent"><Bot size={19} /><div><strong>{data.name}</strong><small><Code2 size={12} />{data.harness}</small></div><Handle type="source" position={Position.Right} isConnectable={false} /></div>
}
function GraphCapability({ data }: NodeProps<Node<CapabilityData>>) {
  const { item, planned } = data
  const Icon = item.kind === 'skill' ? Puzzle : Wrench
  return <button className={`graph-capability nodrag nopan ${item.kind} state-${item.state}`} ref={element => data.buttonRef(item.id, element)} onClick={() => data.onInspect(item)} aria-label={`Inspect ${item.name}: ${planned && item.required ? 'Will load' : item.label}${data.scoped ? ` · ${item.agentName}` : ''}`}><Handle type="target" position={Position.Left} isConnectable={false} /><Icon size={18} /><span className="graph-capability-copy"><strong>{item.name}{item.required && <span className="required-mini">Required</span>}</strong><small>{item.state === 'loaded' || item.state === 'observed' ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}{planned && item.required ? 'Will load' : item.label}</small></span></button>
}
const nodeTypes = { capabilityAgent: GraphAgent, capabilityItem: GraphCapability }
export function CapabilityGraph({ items, harnesses, planned, scoped, onInspect, buttonRef }: { items: Capability[]; harnesses: ReadonlyMap<string,string>; planned: boolean; scoped: boolean; onInspect: (item: Capability) => void; buttonRef: CapabilityData['buttonRef'] }) {
  const graph = useMemo(() => {
    const nodes: Node[] = [], edges: Edge[] = []
    let offset = 0
    for (const agentId of new Set(items.map(item => item.agentId))) {
      const owned = items.filter(item => item.agentId === agentId)
      const height = Math.max(96, owned.length * 87)
      nodes.push({ id: agentId, type: 'capabilityAgent', position: { x: 10, y: offset + (height - 58) / 2 }, data: { name: owned[0].agentName, harness: harnesses.get(agentId) ?? 'Not recorded' } })
      owned.forEach((item, i) => {
        const id = `${agentId}:${item.id}`
        nodes.push({ id, type: 'capabilityItem', position: { x: 343, y: offset + i * 87 }, data: { item, planned, scoped, onInspect, buttonRef } })
        edges.push({ id: `${id}:edge`, source: agentId, target: id, type: 'smoothstep', label: item.required ? item.state === 'loaded' ? 'loaded' : item.state === 'read' ? 'read' : 'requires' : 'called', markerEnd: { type: MarkerType.ArrowClosed, color: '#67666c', width: 12, height: 12 }, style: { stroke: '#67666c', strokeWidth: 1.25, strokeDasharray: planned || item.state === 'unverified' ? '4 4' : undefined }, labelStyle: { fill: '#b2b1b7', fontSize: 11 }, labelBgStyle: { fill: '#0e1012' } })
      })
      offset += height + 34
    }
    return { nodes, edges, height: Math.max(305, offset + 30) }
  }, [items, harnesses, planned, scoped, onInspect, buttonRef])
  return <div className={`capability-graph ${scoped ? 'whole-team' : ''}`} aria-label="Agent skills and tools graph" style={{ height: graph.height }}><ReactFlowProvider><ReactFlow key={items.map(item => `${item.agentId}:${item.id}`).join('|')} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.35} maxZoom={1.2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }} /></ReactFlowProvider></div>
}
