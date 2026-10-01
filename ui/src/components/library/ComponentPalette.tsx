import { useEffect, useState } from 'react'
import { Bot, Box, ChartColumn, Code2, GripVertical, PanelLeftClose, PanelLeftOpen, PenLine, Plus, Puzzle, RefreshCw, ScanEye, Scissors, Search, Shapes, Telescope, UserCheck, Wrench, type LucideIcon } from 'lucide-react'
import { harnessProblem } from '../../lib/harnesses'
import { OPERATOR_SOURCE } from '../../lib/library/fixtures'
import { harnessForRole, ROLE_PRESETS, roleSource, type RoleIcon } from '../../lib/library/roles'
import type { LibraryProps } from './Library'
import { CAPABILITY_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'

const ROLE_ICONS: Record<RoleIcon, LucideIcon> = { research: Telescope, write: PenLine, edit: Scissors, review: ScanEye, code: Code2, design: Shapes, analyse: ChartColumn }

export function ComponentPalette({ harnesses, capabilityInventory, capabilitiesLoading, capabilitiesError, onRetryCapabilities, onDragStateChange, onCollapsedChange }: LibraryProps) {
  // On a phone the library would take half the screen, so it starts closed and overlays the canvas
  // when opened; adding something closes it again so the new card is in view.
  const narrow = () => typeof window !== 'undefined' && window.innerWidth < 768
  const [collapsed, setCollapsed] = useState(narrow)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => { onCollapsedChange?.(collapsed) }, [collapsed, onCollapsedChange])
  const groups = [
    // Jobs first: a newcomer knows they need a researcher, not which app to run one on. Each job is
    // placed with working instructions on the best installed app, which stays changeable in its
    // settings. "You" is the review step that pauses the team for the operator's approval.
    { name: 'Hire by job', items: [
      ...ROLE_PRESETS.map(preset => {
        const harness = harnessForRole(preset, harnesses)
        return { name: preset.label, detail: preset.does, engine: harness ? `on ${harness.name}` : 'needs an AI app', Icon: ROLE_ICONS[preset.icon], mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: !harness, payload: (roleSource(preset, harnesses) ?? {}) as object }
      }),
      { name: 'You (review step)', detail: 'Pause so you can approve the work', Icon: UserCheck, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: false, payload: OPERATOR_SOURCE as object },
    ] },
    // The same agents without a job: an app and an empty brief, for operators who write their own.
    { name: 'AI apps', items: [
      // An app that last failed to start stays addable — the operator may have just fixed it, and
      // placing it asks for its models again — but it says why it may not run instead of "AI agent".
      ...harnesses.map(h => ({ name: h.name, detail: harnessProblem(h) ?? 'Blank agent · you write its brief', Icon: Bot, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: h.acpAvailable === false, payload: { group: 'detected', id: h.id, label: h.name, spawn: h.spawn } as object })),
    ] },
    ...(['skills', 'tools', 'sources'] as const).map(key => ({ name: { skills: 'Skills', tools: 'Tools', sources: 'Knowledge' }[key], items: (capabilityInventory?.[key] ?? []).map(item => ({ name: item.name, detail: item.source, Icon: key === 'skills' ? Puzzle : key === 'tools' ? Wrench : Box, mime: CAPABILITY_DRAG_MIME, event: 'loomwatch:add-capability', disabled: false, payload: { kind: key === 'skills' ? 'skill' : key === 'tools' ? 'tool' : 'knowledge', name: item.name, source: item.source, ...(item.memory ? { memory: { team: item.memory.team, pack: item.memory.pack } } : {}) } })) })),
  ]
  // The agent list is short and is what a new team needs, so it is shown whole; the capability
  // groups can run to hundreds of entries and fold to three.
  const limitFor = (group: string) => (group === 'Hire by job' ? 8 : group === 'AI apps' ? 4 : 3)
  if (collapsed) return <button className="palette-reopen" onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} />Add agents</button>
  return <aside className="node-palette" aria-label="Add to your team">
    <div className="palette-head"><div><span className="eyebrow">Add to your team</span><p>Click + or drag onto the canvas</p></div><button className="icon-button" onClick={() => setCollapsed(true)} aria-label="Collapse the library"><PanelLeftClose size={16} /></button></div>
    <div className="palette-search"><Search size={12} /><input aria-label="Search agents, skills and tools" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /><button className="icon-button" onClick={onRetryCapabilities} disabled={capabilitiesLoading} aria-label="Scan this computer again"><RefreshCw size={12} /></button></div>
    {capabilitiesError && <p role="alert">{capabilitiesError}</p>}
    {groups.map(group => <section key={group.name}><h3>{group.name}</h3>{group.items.filter(item => `${item.name} ${item.detail}`.toLowerCase().includes(query.toLowerCase())).slice(0, query || expanded[group.name] ? undefined : limitFor(group.name)).map((item, i) => <button key={`${item.name}-${i}`} className="palette-item" disabled={item.disabled} title={'engine' in item && item.engine ? `${item.detail} · ${item.engine}` : item.detail} draggable={!item.disabled} onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(item.mime, JSON.stringify(item.payload)); onDragStateChange?.(true) }} onDragEnd={() => onDragStateChange?.(false)} onClick={() => { window.dispatchEvent(new CustomEvent(item.event, { detail: JSON.stringify(item.payload) })); if (narrow()) setCollapsed(true) }}><GripVertical size={13} /><span className="palette-icon"><item.Icon size={15} /></span><span><strong>{item.name}</strong><small>{item.detail}</small>{'engine' in item && item.engine && <em className="palette-engine">{item.engine}</em>}</span><Plus size={13} /></button>)}{!query && group.items.length > limitFor(group.name) && <button className="palette-more" onClick={() => setExpanded(current => ({ ...current, [group.name]: !current[group.name] }))}>{expanded[group.name] ? 'Show less' : `Show ${group.items.length - limitFor(group.name)} more`}</button>}</section>)}
  </aside>
}
