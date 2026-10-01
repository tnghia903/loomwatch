import { useMemo } from 'react';
import { ReactFlow, Handle, Position, MarkerType } from '@xyflow/react';
import { Bot, CheckCircle2, CircleAlert, Clock3, Code2, Globe2, FileText, Puzzle, Wrench } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { capabilitiesFor } from './data';

export function CapabilityIcon({ item, size = 18 }) {
  const Icon = item.kind === 'skill' ? Puzzle : item.id === 'web' || item.id === 'browser' ? Globe2 : FileText;
  return <Icon size={size} aria-hidden="true" />;
}

export function StateIcon({ status, size = 14 }) {
  const Icon = status === 'loaded' || status === 'called' || status === 'done' ? CheckCircle2 : status === 'missing' || status === 'blocked' ? CircleAlert : status === 'running' || status === 'pending' ? Clock3 : Wrench;
  return <Icon size={size} aria-hidden="true" />;
}

function GraphAgent({ data }) {
  return <div className="graph-agent">
    <div className="graph-node-icon"><Bot size={19} /></div>
    <div><strong>{data.agent.name}</strong><small><Code2 size={12} />{data.agent.harness}</small></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}

function GraphCapability({ data }) {
  const { item, onInspect } = data;
  return <button type="button" className={`graph-capability nodrag nopan ${item.kind} state-${item.status}`} onClick={(event) => { event.stopPropagation(); onInspect(item); }} aria-label={`Inspect ${item.name}, ${item.label}, ${data.agentName}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <span className="graph-node-icon"><CapabilityIcon item={item} /></span>
    <span className="graph-capability-copy"><strong>{item.name}{item.kind === 'skill' && <span className="required-mini">Required</span>}</strong><small><StateIcon status={item.status} size={12} />{item.label}</small></span>
  </button>;
}

const nodeTypes = { agent: GraphAgent, capability: GraphCapability };

export function CapabilityGraph({ agents, run, filter, build, onInspect }) {
  const { nodes, edges } = useMemo(() => {
    const nodes = [], edges = [];
    let offset = 0;
    for (const agent of agents) {
      const items = capabilitiesFor(agent, run, build).filter((item) => filter === 'all' || item.kind === filter);
      if (!items.length) continue;
      const groupHeight = Math.max(96, items.length * 87);
      nodes.push({ id: agent.id, type: 'agent', position: { x: 10, y: offset + (groupHeight - 58) / 2 }, data: { agent }, draggable: false, selectable: false, focusable: false });
      items.forEach((item, i) => {
        const id = `${agent.id}:${item.kind}:${item.id}`;
        nodes.push({ id, type: 'capability', position: { x: 343, y: offset + i * 87 }, data: { item, onInspect, agentName: agent.name }, draggable: false, selectable: false, focusable: false });
        edges.push({ id: `${id}:edge`, source: agent.id, target: id, type: 'smoothstep', label: build ? item.kind === 'skill' ? 'requires' : 'makes available' : item.kind === 'skill' ? item.status === 'loaded' ? 'loaded' : item.status === 'missing' ? 'load missing' : 'will load' : item.status === 'called' ? `called ×${item.count}` : 'available',
          markerEnd: { type: MarkerType.ArrowClosed, color: item.status === 'missing' ? 'var(--danger)' : 'var(--line-strong)', width: 12, height: 12 },
          style: { stroke: item.status === 'missing' ? 'var(--danger)' : 'var(--line-strong)', strokeWidth: 1.25, strokeDasharray: build || item.status === 'missing' || item.status === 'pending' ? '4 4' : undefined },
          labelStyle: { fill: item.status === 'missing' ? 'var(--danger)' : 'var(--muted)', fontSize: 11 },
          labelBgStyle: { fill: 'var(--graph-bg)' }, labelBgPadding: [7, 4], labelBgBorderRadius: 3, selectable: false, focusable: false,
        });
      });
      offset += groupHeight + 34;
    }
    return { nodes, edges };
  }, [agents, run, filter, build, onInspect]);

  if (!nodes.length) return <div className="graph-empty"><Puzzle size={24} /><strong>No skills attached to this agent</strong><p>Attach a required skill in Build to see its loading state here.</p></div>;
  return <div className={`capability-graph ${agents.length > 1 ? 'whole-team' : ''}`} aria-label="Agent skills and tools graph">
    <ReactFlow key={`${agents.map((agent) => agent.id).join()}:${filter}:${build}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => { if (node.data.item) onInspect(node.data.item); }} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.35} maxZoom={1.2} nodesConnectable={false} nodesDraggable={false} panOnDrag={true} zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} ariaLabelConfig={{ 'pane.ariaLabel': 'Skills and tools graph. Use the List view for a linear reading order.' }} />
  </div>;
}
