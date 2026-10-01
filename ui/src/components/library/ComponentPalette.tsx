import { useEffect, useState } from 'react'
import { Box, Code2, GripVertical, PanelLeftClose, PanelLeftOpen, Plus, Puzzle, RefreshCw, Search, Wrench } from 'lucide-react'
import type { LibraryProps } from './Library'
import { CAPABILITY_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'

export function ComponentPalette({ harnesses, capabilityInventory, capabilitiesLoading, capabilitiesError, onRetryCapabilities, onDragStateChange, onCollapsedChange }: LibraryProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => { onCollapsedChange?.(collapsed) }, [collapsed, onCollapsedChange])
  const groups = [
    { name: 'Harnesses', items: harnesses.map(h => ({ name: h.name, detail: h.acpAvailable === false ? h.unavailableReason ?? 'Unavailable' : 'Agent runtime', Icon: Code2, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: h.acpAvailable === false, payload: { group: 'detected', id: h.id, label: h.name, spawn: h.spawn } })) },
    ...(['skills', 'tools', 'sources'] as const).map(key => ({ name: { skills: 'Skills', tools: 'Tools', sources: 'Knowledge' }[key], items: (capabilityInventory?.[key] ?? []).map(item => ({ name: item.name, detail: item.source, Icon: key === 'skills' ? Puzzle : key === 'tools' ? Wrench : Box, mime: CAPABILITY_DRAG_MIME, event: 'loomwatch:add-capability', disabled: false, payload: { kind: key === 'skills' ? 'skill' : key === 'tools' ? 'tool' : 'knowledge', name: item.name, source: item.source, ...(item.memory ? { memory: { team: item.memory.team, pack: item.memory.pack } } : {}) } })) })),
  ]
  if (collapsed) return <button className="palette-reopen" onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} />Components</button>
  return <aside className="node-palette" aria-label="Components">
    <div className="palette-head"><div><span className="eyebrow">Component library</span><p>Drag onto the canvas</p></div><button className="icon-button" onClick={() => setCollapsed(true)} aria-label="Collapse component library"><PanelLeftClose size={16} /></button></div>
    <div className="palette-search"><Search size={12} /><input aria-label="Search components" placeholder="Find a component" value={query} onChange={e => setQuery(e.target.value)} /><button className="icon-button" onClick={onRetryCapabilities} disabled={capabilitiesLoading} aria-label="Scan local components"><RefreshCw size={12} /></button></div>
    {capabilitiesError && <p role="alert">{capabilitiesError}</p>}
    {groups.map(group => <section key={group.name}><h3>{group.name}</h3>{group.items.filter(item => `${item.name} ${item.detail}`.toLowerCase().includes(query.toLowerCase())).slice(0, query || expanded[group.name] ? undefined : 3).map((item, i) => <button key={`${item.name}-${i}`} className="palette-item" disabled={item.disabled} title={item.detail} draggable={!item.disabled} onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(item.mime, JSON.stringify(item.payload)); onDragStateChange?.(true) }} onDragEnd={() => onDragStateChange?.(false)} onClick={() => window.dispatchEvent(new CustomEvent(item.event, { detail: JSON.stringify(item.payload) }))}><GripVertical size={13} /><span className="palette-icon"><item.Icon size={15} /></span><span><strong>{item.name}</strong><small>{item.detail}</small></span><Plus size={13} /></button>)}{!query && group.items.length > 3 && <button className="palette-more" onClick={() => setExpanded(current => ({ ...current, [group.name]: !current[group.name] }))}>{expanded[group.name] ? 'Show less' : `Show ${group.items.length - 3} more`}</button>}</section>)}
  </aside>
}
