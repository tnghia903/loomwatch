import { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import { Bot, Box, Code2, FileText, Globe2, GripVertical, Info, PanelLeftClose, PanelLeftOpen, Plus, Puzzle, Trash2, Wrench } from 'lucide-react';
import '@xyflow/react/dist/style.css';

const graphKey = 'loomwatch-delivery-lane-build-graph-v1';

const catalog = [
  { group: 'Harnesses', items: [
    { catalogId: 'codex', type: 'harness', name: 'Codex', detail: 'Agent runtime', icon: Code2 },
    { catalogId: 'claude-code', type: 'harness', name: 'Claude Code', detail: 'Agent runtime', icon: Code2 },
    { catalogId: 'opencode', type: 'harness', name: 'OpenCode', detail: 'Agent runtime', icon: Code2 },
  ] },
  { group: 'Skills', items: [
    { catalogId: 'claude-design', type: 'skill', name: 'claude-design', detail: 'Found in Claude Code', icon: Puzzle },
    { catalogId: 'source-check', type: 'skill', name: 'source-check', detail: 'Shared skill', icon: Puzzle },
    { catalogId: 'report-writing', type: 'skill', name: 'report-writing', detail: 'Found in Codex', icon: Puzzle },
  ] },
  { group: 'Tools', items: [
    { catalogId: 'browser', type: 'tool', name: 'Browser', detail: 'Open references', icon: Globe2 },
    { catalogId: 'web', type: 'tool', name: 'Web search', detail: 'Search the web', icon: Globe2 },
    { catalogId: 'files', type: 'tool', name: 'Read files', detail: 'Local workspace', icon: FileText },
  ] },
  { group: 'Knowledge', items: [
    { catalogId: 'project', type: 'knowledge', name: 'LoomWatch project', detail: 'Local folder', icon: Box },
    { catalogId: 'brief', type: 'knowledge', name: 'Research brief', detail: 'Document', icon: FileText },
  ] },
];

const initialNodes = [
  { id: 'researcher', type: 'buildNode', position: { x: 50, y: 75 }, data: { kind: 'harness', name: 'Researcher', harness: 'Codex', role: 'Market researcher', primary: true }, deletable: false },
  { id: 'designer', type: 'buildNode', position: { x: 390, y: 75 }, data: { kind: 'harness', name: 'Report Designer', harness: 'Codex', role: 'Report writer and designer', primary: true }, deletable: false },
  { id: 'skill-claude-design', type: 'buildNode', position: { x: 390, y: 280 }, data: { kind: 'skill', name: 'claude-design', detail: 'Found in Claude Code' } },
  { id: 'tool-web', type: 'buildNode', position: { x: 50, y: 280 }, data: { kind: 'tool', name: 'Web search', detail: 'Search the web' } },
  { id: 'knowledge-project', type: 'buildNode', position: { x: 50, y: 425 }, data: { kind: 'knowledge', name: 'LoomWatch project', detail: 'Local folder' } },
  { id: 'output', type: 'buildNode', position: { x: 735, y: 130 }, data: { kind: 'output', name: 'Market research report', detail: 'Markdown report' }, deletable: false },
];

const edgeStyle = { stroke: '#858078', strokeWidth: 1.35 };
const initialEdges = [
  ['handoff', 'researcher', 'designer', 'hands off'],
  ['research-web', 'researcher', 'tool-web', 'can use'],
  ['research-project', 'researcher', 'knowledge-project', 'reads'],
  ['design-skill', 'designer', 'skill-claude-design', 'requires'],
  ['design-output', 'designer', 'output', 'produces'],
].map(([id, source, target, label]) => ({ id, source, target, label, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#858078' }, style: { ...edgeStyle, strokeDasharray: ['requires', 'can use', 'reads'].includes(label) ? '5 4' : undefined }, labelStyle: { fill: '#b7b4ad', fontSize: 10 }, labelBgStyle: { fill: '#141516' }, labelBgPadding: [6, 3], labelBgBorderRadius: 3 }));

function readGraph() {
  try {
    const saved = JSON.parse(localStorage.getItem(graphKey));
    if (Array.isArray(saved?.nodes) && Array.isArray(saved?.edges)) return { ...saved, nodes: saved.nodes.map((node) => node.data?.primary || node.id === 'output' ? { ...node, deletable: false } : node) };
  } catch { /* Start from the example graph. */ }
  return { nodes: initialNodes, edges: initialEdges };
}

const icons = { harness: Bot, skill: Puzzle, tool: Wrench, knowledge: Box, output: FileText };

function BuildNode({ data, selected }) {
  const Icon = icons[data.kind] || Box;
  const acceptsInput = true;
  const hasOutput = data.kind === 'harness';
  return <article className={`build-node kind-${data.kind} ${selected ? 'selected' : ''}`}>
    {acceptsInput && <Handle type="target" position={Position.Left} className="build-handle" />}
    <span className="build-node-icon"><Icon size={18} /></span>
    <div><span className="node-kind">{data.kind === 'harness' ? data.harness : data.kind}</span><strong>{data.name}</strong><small>{data.kind === 'harness' ? data.role : data.detail}</small></div>
    {data.primary && <span className="primary-chip">Run</span>}
    {hasOutput && <Handle type="source" position={Position.Right} className="build-handle" />}
  </article>;
}

const nodeTypes = { buildNode: BuildNode };

function relationFor(target) {
  if (target.data.kind === 'harness') return 'hands off';
  if (target.data.kind === 'skill') return 'requires';
  if (target.data.kind === 'tool') return 'can use';
  if (target.data.kind === 'knowledge') return 'reads';
  return 'produces';
}

function Canvas({ team, onTeamChange, onDirty, onNotice }) {
  const stored = useMemo(readGraph, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(stored.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(stored.edges);
  const [selectedId, setSelectedId] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const selectedNode = nodes.find((node) => node.id === selectedId);

  useEffect(() => { localStorage.setItem(graphKey, JSON.stringify({ nodes, edges })); }, [nodes, edges]);
  useEffect(() => { setNodes((current) => current.map((node) => node.id === 'output' ? { ...node, data: { ...node.data, name: team.output, detail: team.format } } : node)); }, [team.output, team.format, setNodes]);

  const updatePrimaryTeam = useCallback((nextNodes, nextEdges) => {
    onTeamChange((current) => ({ ...current, agents: current.agents.map((agent) => {
      const node = nextNodes.find((item) => item.id === agent.id);
      if (!node) return agent;
      const connected = nextEdges.filter((edge) => edge.source === agent.id).map((edge) => nextNodes.find((item) => item.id === edge.target)).filter(Boolean);
      return { ...agent, name: node.data.name, role: node.data.role, harness: node.data.harness, skills: connected.filter((item) => item.data.kind === 'skill').map((item) => item.data.catalogId || item.data.name), tools: connected.filter((item) => item.data.kind === 'tool').map((item) => item.data.catalogId || item.data.name.toLowerCase().replace('read ', '').replace(' search', '')) };
    }) }));
  }, [onTeamChange]);

  const markChanged = useCallback((nextNodes = nodes, nextEdges = edges) => { onDirty(); updatePrimaryTeam(nextNodes, nextEdges); }, [edges, nodes, onDirty, updatePrimaryTeam]);

  const connect = useCallback((connection) => {
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target || source.data.kind !== 'harness' || !['harness', 'skill', 'tool', 'knowledge', 'output'].includes(target.data.kind) || source.id === target.id) {
      onNotice('Start a connection from a harness and end it at another harness or resource.'); return;
    }
    if (edges.some((edge) => edge.source === source.id && edge.target === target.id)) { onNotice('Those nodes are already connected.'); return; }
    const label = relationFor(target);
    const resourceEdge = ['skill', 'tool', 'knowledge'].includes(target.data.kind);
    const edge = { ...connection, id: `edge-${source.id}-${target.id}-${Date.now()}`, label, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#858078' }, style: { ...edgeStyle, strokeDasharray: resourceEdge ? '5 4' : undefined }, labelStyle: { fill: '#b7b4ad', fontSize: 10 }, labelBgStyle: { fill: '#141516' }, labelBgPadding: [6, 3], labelBgBorderRadius: 3 };
    const nextEdges = [...edges, edge]; setEdges(nextEdges); markChanged(nodes, nextEdges); onNotice(`${source.data.name} ${label} ${target.data.name}.`);
  }, [edges, markChanged, nodes, onNotice, setEdges]);

  const addItem = useCallback((item, screenPosition) => {
    const position = screenPosition ? screenToFlowPosition(screenPosition) : screenToFlowPosition({ x: window.innerWidth * .46, y: window.innerHeight * .48 });
    const count = nodes.filter((node) => node.data.catalogId === item.catalogId).length + 1;
    const id = `${item.type}-${item.catalogId}-${Date.now()}`;
    const data = item.type === 'harness'
      ? { kind: 'harness', name: `${item.name} agent ${count}`, harness: item.name, role: 'New team member', catalogId: item.catalogId }
      : { kind: item.type, name: item.name, detail: item.detail, catalogId: item.catalogId };
    const nextNodes = [...nodes.map((node) => ({ ...node, selected: false })), { id, type: 'buildNode', position, data, selected: true }];
    setNodes(nextNodes); setSelectedId(id); markChanged(nextNodes, edges); onNotice(`${item.name} added. Drag from its connector to wire it.`);
  }, [edges, markChanged, nodes, onNotice, screenToFlowPosition, setNodes]);

  function onDrop(event) {
    event.preventDefault();
    try { const item = JSON.parse(event.dataTransfer.getData('application/loomwatch-node')); if (item) addItem(item, { x: event.clientX, y: event.clientY }); } catch { onNotice('That item could not be added.'); }
  }

  function changeSelected(key, value) {
    const nextNodes = nodes.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, [key]: value } } : node);
    setNodes(nextNodes); markChanged(nextNodes, edges);
    if (selectedId === 'output') onTeamChange((current) => ({ ...current, [key === 'name' ? 'output' : 'format']: value }));
  }

  function removeSelected() {
    if (!selectedNode || selectedNode.id === 'output' || selectedNode.data.primary) return;
    const nextNodes = nodes.filter((node) => node.id !== selectedId);
    const nextEdges = edges.filter((edge) => edge.source !== selectedId && edge.target !== selectedId);
    setNodes(nextNodes); setEdges(nextEdges); setSelectedId(null); markChanged(nextNodes, nextEdges); onNotice(`${selectedNode.data.name} removed.`);
  }

  return <div className={`build-canvas-shell ${paletteOpen ? '' : 'palette-collapsed'}`}>
    <aside className="node-palette" aria-label="Components">
      <div className="palette-head"><div><span className="eyebrow">Component library</span><p>Drag onto the canvas</p></div><button className="icon-button" onClick={() => setPaletteOpen(false)} aria-label="Collapse component library"><PanelLeftClose size={16} /></button></div>
      {catalog.map((section) => <section key={section.group}><h3>{section.group}</h3>{section.items.map((item) => { const Icon = item.icon; return <button key={item.catalogId} className="palette-item" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/loomwatch-node', JSON.stringify(item)); }} onClick={() => addItem(item)}><GripVertical size={13} /><span className="palette-icon"><Icon size={15} /></span><span><strong>{item.name}</strong><small>{item.detail}</small></span><Plus size={13} /></button>; })}</section>)}
    </aside>
    {!paletteOpen && <button className="palette-reopen" onClick={() => setPaletteOpen(true)}><PanelLeftOpen size={16} />Components</button>}
    <div className="build-canvas" onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}>
      <div className="canvas-help"><strong>Wire the team</strong><span>Drag nodes anywhere. Connect from the right side of a harness.</span></div>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={(changes) => { onNodesChange(changes); if (changes.some((change) => change.type === 'position' && !change.dragging)) onDirty(); }} onEdgesChange={(changes) => { onEdgesChange(changes); if (changes.some((change) => change.type === 'remove')) onDirty(); }} onConnect={connect} onNodeClick={(_, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} onSelectionChange={({ nodes: selected }) => setSelectedId(selected[0]?.id || null)} fitView fitViewOptions={{ padding: .2 }} minZoom={.35} maxZoom={1.5} deleteKeyCode={['Backspace', 'Delete']} nodesConnectable edgesFocusable snapToGrid snapGrid={[12, 12]}>
        <Background color="#303236" gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      <button className="fit-canvas" onClick={() => fitView({ padding: .2, duration: 250 })}>Fit team</button>
      <div className="canvas-legend"><span><i className="legend-line solid" />Workflow</span><span><i className="legend-line dotted" />Resources</span><span><Info size={12} />Select a node to edit</span></div>
    </div>
    {selectedNode && <aside className="node-inspector" aria-label="Selected node settings">
      <div className="inspector-head"><div><span className="eyebrow">Selected {selectedNode.data.kind}</span><strong>{selectedNode.data.name}</strong></div>{selectedNode.id !== 'output' && !selectedNode.data.primary && <button className="icon-button danger" onClick={removeSelected} aria-label={`Remove ${selectedNode.data.name}`}><Trash2 size={15} /></button>}</div>
      {selectedNode.data.kind === 'harness' ? <div className="inspector-fields"><label>Agent name<input value={selectedNode.data.name} onChange={(event) => changeSelected('name', event.target.value)} /></label><label>Role<input value={selectedNode.data.role} onChange={(event) => changeSelected('role', event.target.value)} /></label><label>Harness<select value={selectedNode.data.harness} onChange={(event) => changeSelected('harness', event.target.value)}><option>Codex</option><option>Claude Code</option><option>OpenCode</option></select></label><p><Puzzle size={13} />Skills remain portable across harnesses.</p></div> : selectedNode.data.kind === 'output' ? <div className="inspector-fields"><label>Deliverable name<input value={selectedNode.data.name} onChange={(event) => changeSelected('name', event.target.value)} /></label><label>Format<select value={selectedNode.data.detail} onChange={(event) => changeSelected('detail', event.target.value)}><option>Markdown report</option><option>HTML dashboard</option><option>Document and files</option></select></label><p><FileText size={13} />Connect the final harness to make its ownership explicit.</p></div> : <div className="inspector-readonly"><span>{selectedNode.data.detail}</span><p>Wire this node from a harness to include it in that agent’s run packet.</p></div>}
    </aside>}
  </div>;
}

export function BuildCanvas(props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
