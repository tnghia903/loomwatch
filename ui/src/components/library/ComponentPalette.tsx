import { useEffect, useState, type ReactNode } from 'react'
import { BookmarkCheck, Box, ChartColumn, ChartSpline, Clapperboard, Code2, ExternalLink, FileText, Folder, GripVertical, Info, LayoutDashboard, LocateFixed, NotebookText, PanelLeftClose, PanelLeftOpen, PenLine, Plug, Plus, Presentation, Puzzle, RefreshCw, ScanEye, Scissors, ScrollText, Search, Shapes, Sheet, Telescope, Trash2, UserCheck, UserRound, type IconComponent } from '../ui/icon'
import { DEFAULT_MODEL, modelNameFromId } from '../../lib/ai/modelIds'
import { OPERATOR_SOURCE } from '../../lib/library/fixtures'
import { benchChatOwner, removeJob, savedJobPreset, useSavedJobs } from '../../lib/library/jobs'
import { isOpenTeam, teamAgentSource, useAgentUses, type TeamOwnAgent } from '../../lib/library/uses'
import { agentFigure, figureFor, type FigureChoice } from '../../lib/library/figures'
import { FigureStill } from '../agents/FigureStill'
import { modelForPreset, roleSource, type RoleIcon, type RolePreset } from '../../lib/library/roles'
import type { CapabilityInventory, DetectedCapability } from '../../lib/library/client'
import type { CapabilityDragPayload, CapabilityKind } from '../../lib/composer-layout/types'
import { CAPABILITY_DRAG_MIME, CONNECTION_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'
import { chosenIsFile } from '../../lib/knowledge/chosen'
import { CONNECT_NOTION_HREF, NOTION_PAGE_SOURCE, type NotionConnection } from '../../lib/notion/connection'
import { PALETTE_WIDTH } from '../../lib/library/paletteWidth'
import { PaletteResizer } from './PaletteResizer'
import { SectionHead } from '../ui/SectionHead'
import { keys } from '../../lib/platform'
import { InlineMarkdown } from '../ui/Markdown'
import { plainWords } from '../../lib/chat/findWords'

const ROLE_ICONS: Record<RoleIcon, IconComponent> = { research: Telescope, write: PenLine, edit: Scissors, review: ScanEye, code: Code2, design: Shapes, analyse: ChartColumn, slides: Presentation, document: ScrollText, sheet: Sheet, chart: ChartSpline, dashboard: LayoutDashboard, video: Clapperboard }

const YOURS = 'My agents'
const STEPS = 'Workflow steps'
const SKILLS = 'Skills'
const CONNECTIONS = 'Connections'
const FILES = 'Folders & files'
const MEMORY = 'Team memory'

export interface LibraryProps {
  capabilityInventory?: CapabilityInventory
  capabilitiesLoading?: boolean
  capabilitiesError?: string | null
  capabilitiesScannedAt?: Date | null
  onRetryCapabilities?: () => void
  /** A skill or knowledge row's details, which also connect it to agents. */
  onInspectCapability?: (item: DetectedCapability, kind: CapabilityKind) => void
  onDragStateChange?: (dragging: boolean) => void
  /** Lets the shell keep its layout clear of the panel. */
  onCollapsedChange?: (collapsed: boolean) => void
  /** This team's folders and files, one per card, and who reads each. */
  teamSources?: readonly TeamSource[]
  /** Find a source's card on the canvas and open it. */
  onRevealSource?: (id: string) => void
  /** Notion as this daemon is connected to it, and the pages this team reads (ADR 0050). */
  notion?: NotionPanel
  /** The open team's file, so "Build a new agent" comes back to it. */
  teamPath?: string | null
  /** This team's own agents, as the canvas has them now, listed with My agents. */
  teamAgents?: readonly { id: string; name: string }[]
  /** Select one of this team's agents on the canvas and bring it into view. */
  onRevealAgent?: (id: string) => void
  /** The panel's width in pixels, and how dragging its edge changes it. Absent: it cannot be resized. */
  width?: number
  onResize?: (width: number) => void
}

/** A folder or file of this team, as the panel lists it (ADR 0042). */
export interface TeamSource {
  /** Its card's id. */
  id: string
  name: string
  path: string
  /** "Linked folder" or "Added file". */
  source: string
  /** The names of the agents that read it. */
  readers: readonly string[]
  /** What its details panel shows. */
  item: DetectedCapability
}

/** The Connections group's Notion rows (ADR 0050). */
export interface NotionPanel {
  connection: NotionConnection
  /** One per Notion page card, with who reads each. */
  pages: readonly TeamNotionPage[]
  /** Choose a page with no agent in mind; its card is placed on the canvas. */
  onChoosePage?: () => void
}

/** A Notion page this team reads, as the panel lists it. */
export interface TeamNotionPage {
  /** Its card's id. */
  id: string
  name: string
  page: string
  readers: readonly string[]
  item: DetectedCapability
}

interface PaletteItem {
  name: string
  detail: string
  /** A third line: the model a job runs on, or where a capability comes from. */
  engine?: string
  quiet?: boolean
  Icon: IconComponent
  mime: string
  event: string
  disabled: boolean
  payload: object
  /** A saved job's id: the row offers to remove it. */
  jobId?: string
  /** One of My agents wears its figure here, as it does on Home and on the canvas. */
  figure?: FigureChoice
  /** The row's tooltip, when it says more than its detail and engine lines. */
  hint?: string
  /** A skill or knowledge source: the row offers its details. */
  capability?: { item: DetectedCapability; kind: CapabilityKind }
  /** What a click does instead of adding: a folder or file already has a card, so it is found. */
  onActivate?: () => void
  /** The icon at the end of the row, when a click does not add. */
  Trailing?: IconComponent
  /** `false` for a row that can be clicked but not dragged: Notion before it is connected. */
  draggable?: boolean
  /** Listed under the row before it: a Notion page under Notion. */
  nested?: boolean
}

function jobItem(preset: RolePreset, jobId?: string): PaletteItem {
  return { name: preset.label, detail: preset.does, engine: `on ${modelNameFromId(modelForPreset(preset).model)}`, Icon: preset.icon ? ROLE_ICONS[preset.icon] : BookmarkCheck, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: false, payload: roleSource(preset) as object, ...(jobId ? { jobId } : {}) }
}

/** One of this team's own agents, in the figure its card wears: it is already on the canvas, so a click finds its card. */
function hereItem(agent: { id: string; name: string }, figure: FigureChoice, reveal?: (id: string) => void): PaletteItem {
  return { name: agent.name, detail: 'On this canvas', hint: `Show ${agent.name} on the canvas`, Icon: UserRound, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: !reveal, payload: {}, draggable: false, figure, ...(reveal ? { onActivate: () => reveal(agent.id), Trailing: LocateFixed } : {}) }
}

/** Another team's agent not yet in My agents: once both teams are saved, an identical one is one agent (ADR 0094). */
function elsewhereItem(agent: TeamOwnAgent): PaletteItem {
  const source = teamAgentSource(agent.agent)
  return { name: agent.agentName, detail: `in ${agent.teamName}`, engine: `on ${modelNameFromId(source.model ?? DEFAULT_MODEL)}`, hint: `Add ${agent.agentName} to this team.`, Icon: UserRound, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: false, payload: source as object, figure: figureFor(agent.agentId) }
}

/** "You": the review step that pauses the team for the operator's approval. It is a step, not an agent. */
const REVIEW_STEP: PaletteItem = { name: 'You (review step)', detail: 'Pause so you can approve the work', Icon: UserCheck, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: false, payload: OPERATOR_SOURCE as object }

function capabilityItem(item: DetectedCapability, kind: CapabilityKind): PaletteItem {
  const payload: CapabilityDragPayload = { kind, name: item.name, source: item.source, ...(item.memory ? { memory: { team: item.memory.team, pack: item.memory.pack } } : {}) }
  return { name: item.name, detail: item.source, engine: item.status, quiet: item.status === 'Local only', Icon: kind === 'skill' ? Puzzle : Box, mime: CAPABILITY_DRAG_MIME, event: 'loomwatch:add-capability', disabled: false, payload, capability: { item, kind } }
}

const listOf = (names: readonly string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * A folder or file of this team (ADR 0042). Dragging it onto an agent connects it to that agent;
 * a click finds its card, which every source already has.
 */
function sourceItem(source: TeamSource, reveal?: (id: string) => void): PaletteItem {
  const payload: CapabilityDragPayload = { kind: 'knowledge', name: source.name, source: source.source, path: source.path }
  return {
    name: source.name,
    detail: source.readers.length ? `Read by ${listOf(source.readers)}` : 'No agent reads it yet',
    engine: source.source,
    quiet: true,
    Icon: chosenIsFile(source.path) ? FileText : Folder,
    mime: CAPABILITY_DRAG_MIME,
    event: 'loomwatch:add-capability',
    disabled: false,
    payload,
    capability: { item: source.item, kind: 'knowledge' },
    ...(reveal ? { onActivate: () => reveal(source.id), Trailing: LocateFixed } : {}),
  }
}

/**
 * Notion in the Connections group (ADR 0050). Connected, it is dragged onto an agent, which then
 * asks which page; a click asks with no agent, for a card on its own. Not connected, a click opens
 * Connections, and it cannot be dragged, since there is no page to choose yet.
 */
function notionServiceItem(panel: NotionPanel): PaletteItem {
  const base = { name: 'Notion', Icon: Plug, mime: CONNECTION_DRAG_MIME, event: '', payload: { service: 'notion' } }
  const openConnections = () => { window.open(CONNECT_NOTION_HREF, '_blank', 'noopener') }
  switch (panel.connection.state) {
    case 'connected':
      return { ...base, detail: 'Drag onto an agent, then choose a page', engine: panel.connection.name, quiet: true, disabled: !panel.onChoosePage, ...(panel.onChoosePage ? { onActivate: panel.onChoosePage } : {}) }
    case 'disconnected':
      return { ...base, detail: 'Not connected · click to connect', disabled: false, draggable: false, onActivate: openConnections, Trailing: ExternalLink }
    case 'loading':
      return { ...base, detail: 'Checking the connection…', disabled: true }
    case 'unavailable':
      return { ...base, detail: panel.connection.message, disabled: true }
  }
}

/** A Notion page this team reads: dragged onto an agent to share it, clicked to find its card. */
function notionPageItem(page: TeamNotionPage, reveal?: (id: string) => void): PaletteItem {
  const payload: CapabilityDragPayload = { kind: 'knowledge', name: page.name, source: NOTION_PAGE_SOURCE, notion: { page: page.page } }
  return {
    name: page.name,
    detail: page.readers.length ? `Read by ${listOf(page.readers)}` : 'No agent reads it yet',
    Icon: NotebookText,
    mime: CAPABILITY_DRAG_MIME,
    event: 'loomwatch:add-capability',
    disabled: false,
    payload,
    capability: { item: page.item, kind: 'knowledge' },
    nested: true,
    ...(reveal ? { onActivate: () => reveal(page.id), Trailing: LocateFixed } : {}),
  }
}

/**
 * What each group is, behind its heading's "?". The panel itself shows rows, or one dashed slot
 * when a group is empty; these sentences are for whoever wonders why.
 */
const EXPLAIN: Record<string, ReactNode> = {
  [STEPS]: 'Steps of the workflow that are not agents. You (review step) pauses the team so you can approve the work or send it back.',
  [SKILLS]: <>LoomWatch’s skills, and the ones this team’s project folder has. Drag one onto an agent to supply its instructions there. Add, bring in or install skills on the <a href="/skills">Skills</a> page. Web search, commands and file edits need no skill: switch them on per agent, under <b>Allowed without asking</b>.</>,
  [CONNECTIONS]: <>Services you connected in Connections. Drag <b>Notion</b> onto an agent and choose a page: the agent is given the page’s text each time the team runs. The pages this team reads are listed under it.</>,
  [FILES]: <>This team’s folders and files. Add one from an agent’s panel, with <b>Folder</b> or <b>File</b> under Given. Then drag it onto another agent to share it, or click it to find its card.</>,
  [MEMORY]: 'Other teams’ memory and imported packs. Drag one onto an agent to supply it there.',
  [YOURS]: <>A team’s agents come from here. Each is the same agent in every team it’s in. Build one in <a href="/agents">My agents</a>, starting from a job such as Researcher or Writer, and try it there first.</>,
}

/** The one add panel, beside the Workflow canvas (ADR 0041): what you can add — jobs, skills, knowledge. */
export function ComponentPalette({ capabilityInventory, capabilitiesLoading = false, capabilitiesError = null, capabilitiesScannedAt = null, onRetryCapabilities, onInspectCapability, onDragStateChange, onCollapsedChange, teamSources = [], onRevealSource, notion, teamPath = null, teamAgents = [], onRevealAgent, width, onResize }: LibraryProps) {
  // On a phone the panel would take half the screen, so it starts closed and overlays the canvas
  // when opened; adding something closes it again so the new card is in view.
  const narrow = () => typeof window !== 'undefined' && window.innerWidth < 768
  const [collapsed, setCollapsed] = useState(narrow)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // A saved job is removed on a second click, so one stray click never loses it.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const saved = useSavedJobs()
  // Agents written straight into a team are the operator's agents too, and Home lists them with
  // their team, so this list does as well. This team's are read from the canvas, which is newer
  // than its file while it is being edited.
  const { own: teamOwn, root: teamsRoot } = useAgentUses()
  useEffect(() => { onCollapsedChange?.(collapsed) }, [collapsed, onCollapsedChange])
  const expand = () => {
    setCollapsed(false)
    window.dispatchEvent(new Event('loomwatch:open-library'))
  }
  // Something else needs the canvas for a moment — an Ask proposal to review, an inspector at
  // tablet width — so the panel folds; ⌘\ toggles it.
  useEffect(() => {
    const fold = () => setCollapsed(true)
    const toggle = () => setCollapsed((current) => {
      if (current) window.dispatchEvent(new Event('loomwatch:open-library'))
      return !current
    })
    window.addEventListener('loomwatch:collapse-palette', fold)
    window.addEventListener('loomwatch:close-library', fold)
    window.addEventListener('loomwatch:toggle-library', toggle)
    return () => {
      window.removeEventListener('loomwatch:collapse-palette', fold)
      window.removeEventListener('loomwatch:close-library', fold)
      window.removeEventListener('loomwatch:toggle-library', toggle)
    }
  }, [])
  // A team's agents are My agents (ADR 0030), each placed as the version you saved. The built-in
  // jobs are templates for building one in My agents, not agents to hire here: an agent is built
  // and tried on its own before a team depends on it. After them, the agents that live in teams:
  // this team's own (found on the canvas) and other teams' (added as a copy).
  const yours = { name: YOURS, items: [
    ...saved.jobs.map(job => { const item = jobItem(savedJobPreset(job), job.id); return { ...item, figure: figureFor(job.id, job.figure) } }),
    ...teamAgents.map(agent => hereItem(agent, agentFigure(agent, saved.jobs, benchChatOwner(teamPath)), onRevealAgent)),
    ...(teamOwn ?? []).filter(agent => !isOpenTeam(agent.teamPath, teamPath, teamsRoot)).map(elsewhereItem),
  ] }
  const groups: { name: string; items: PaletteItem[] }[] = [
    yours,
    { name: STEPS, items: [REVIEW_STEP] },
    { name: SKILLS, items: (capabilityInventory?.skills ?? []).map(item => capabilityItem(item, 'skill')) },
    // Services connected in Connections, and the pages this team reads from them (ADR 0050).
    ...(notion ? [{ name: CONNECTIONS, items: [notionServiceItem(notion), ...notion.pages.map(page => notionPageItem(page, onRevealSource))] }] : []),
    // Chosen, not discovered (ADR 0036): only what this team was given, each with its own card.
    { name: FILES, items: teamSources.map(source => sourceItem(source, onRevealSource)) },
    // Other teams' memory and imported packs: the only knowledge LoomWatch lists for itself.
    { name: MEMORY, items: (capabilityInventory?.sources ?? []).map(item => capabilityItem(item, 'knowledge')) },
  ]
  // The agent lists are short and are what a new team needs, so they are shown whole; the
  // capability groups can run to hundreds of entries and fold to three.
  const limitFor = (group: string) => (group === YOURS ? 8 : group === FILES ? 6 : group === CONNECTIONS ? 7 : 3)
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase())
  const remove = (item: PaletteItem) => {
    if (!item.jobId) return
    if (confirmRemove !== item.jobId) { setConfirmRemove(item.jobId); return }
    setConfirmRemove(null)
    setRemoveError(null)
    removeJob(item.jobId).catch((error: unknown) => setRemoveError(error instanceof Error ? error.message : String(error)))
  }
  const row = (item: PaletteItem, i: number) => {
    const add = <button key={`${item.name}-${i}`} className={item.nested ? 'palette-item nested' : 'palette-item'} disabled={item.disabled} title={item.hint ?? (item.engine ? `${plainWords(item.detail)} · ${item.engine}` : plainWords(item.detail))} draggable={!item.disabled && item.draggable !== false} onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(item.mime, JSON.stringify(item.payload)); e.dataTransfer.setData('text/plain', item.name); onDragStateChange?.(true) }} onDragEnd={() => onDragStateChange?.(false)} onClick={() => { if (item.onActivate) item.onActivate(); else window.dispatchEvent(new CustomEvent(item.event, { detail: JSON.stringify(item.payload) })); if (narrow()) setCollapsed(true) }}><GripVertical size={13} />{item.figure ? <FigureStill className="palette-figure" figure={item.figure} alt="" width={38} height={38} loading="lazy" decoding="async" /> : <span className="palette-icon"><item.Icon size={15} /></span>}<span><strong>{item.name}</strong><small><InlineMarkdown clickable={false}>{item.detail}</InlineMarkdown></small>{item.engine && <em className={item.quiet ? 'palette-engine quiet' : 'palette-engine'}>{item.engine}</em>}</span>{item.Trailing ? <item.Trailing size={13} aria-hidden="true" /> : <Plus size={13} />}</button>
    if (item.capability && onInspectCapability) {
      const { item: capability, kind } = item.capability
      return <div key={`${item.name}-${i}`} className="palette-job">
        {add}
        <button className="palette-job-remove palette-cap-info icon-button" onClick={() => onInspectCapability(capability, kind)} aria-label={`Details for ${item.name}`} title="Details and which agents use it"><Info size={12} /></button>
      </div>
    }
    if (!item.jobId) return add
    const confirming = confirmRemove === item.jobId
    return <div key={`${item.name}-${i}`} className="palette-job" onMouseLeave={() => { if (confirming) setConfirmRemove(null) }}>
      {add}
      <button className={confirming ? 'palette-job-remove confirming' : 'palette-job-remove icon-button'} onClick={() => remove(item)} onBlur={() => { if (confirming) setConfirmRemove(null) }} aria-label={confirming ? `Confirm removing ${item.name} from My agents` : `Remove ${item.name} from My agents`} title={confirming ? 'Click again to remove it from My agents.' : 'Remove from My agents'}>{confirming ? 'Remove' : <Trash2 size={12} />}</button>
    </div>
  }
  const section = (name: string, rows: ReactNode[], total: number, extra?: ReactNode, explain?: ReactNode) => <section key={name} aria-label={name}>
    <SectionHead as="h3" title={name} explain={explain} />
    {rows}
    {!query && total > limitFor(name) && <button className="palette-more" onClick={() => setExpanded(current => ({ ...current, [name]: !current[name] }))}>{expanded[name] ? 'Show less' : `Show ${total - limitFor(name)} more`}</button>}
    {extra}
  </section>
  const visible = <T,>(name: string, items: readonly T[]) => items.slice(0, query || expanded[name] ? undefined : limitFor(name))

  if (collapsed) return <button className="palette-reopen" onClick={expand} title={`Open the panel (${keys('⌘\\')})`}>
    <PanelLeftOpen size={16} />Add agents
  </button>
  const scanned = capabilitiesScannedAt ? `Skills listed at ${capabilitiesScannedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Listing LoomWatch’s skills'
  return <aside className="node-palette" aria-label="Add to your team" data-tour="palette">
    <div className="palette-body">
    <div className="palette-head"><div><span className="eyebrow">Add to your team</span><p>Click + or drag onto the canvas, or onto an agent</p></div><button className="icon-button" onClick={() => setCollapsed(true)} aria-label="Collapse the library" title={`Collapse (${keys('⌘\\')})`}><PanelLeftClose size={16} /></button></div>
    <div className="palette-search"><Search size={12} /><input aria-label="Search agents and skills" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /><button className="icon-button" onClick={onRetryCapabilities} disabled={capabilitiesLoading} aria-label="List the skills again" title="List again"><RefreshCw size={12} /></button></div>
    <p className="palette-scan" role="status">{capabilitiesLoading ? 'Listing skills…' : scanned}</p>
    {capabilitiesError && !capabilitiesLoading && <div className="palette-alert" role="alert"><span>Couldn’t list the skills.</span><small>{capabilitiesError}</small>{onRetryCapabilities && <button className="btn" onClick={onRetryCapabilities}>Try again</button>}</div>}
    {removeError && <p role="alert">{removeError}</p>}
    {groups.map(group => {
      const items = group.items.filter(item => matches(`${item.name} ${item.detail}`))
      if (query && items.length === 0) return null
      const loadingCapabilities = (group.name === SKILLS || group.name === MEMORY) && capabilitiesLoading && group.items.length === 0
      return section(group.name, [
        ...(loadingCapabilities ? [40, 56].map(width => <div key={width} className="skel-row" aria-hidden="true"><span className="skel-sq" /><span className="skel-bars"><i className="skel-bar" style={{ width: `${width}%` }} /><i className="skel-bar" style={{ width: `${100 - width}%` }} /></span></div>) : []),
        ...visible(group.name, items).map(row),
      ], items.length, <>
        {group.name === YOURS && saved.problems.map(problem => <p key={problem.file} className="palette-hint palette-problem" title={problem.message}>Can’t read {problem.file}: {problem.message}</p>)}
        {group.name === YOURS && !query && group.items.length === 0 && saved.loaded && teamOwn !== null && <p className="palette-empty"><UserRound size={13} aria-hidden="true" />None yet</p>}
        {group.name === YOURS && !query && <a className="palette-hint palette-build-agent" href={`/agents/new${teamPath ? `?team=${encodeURIComponent(teamPath)}` : ''}`}>Build a new agent</a>}
        {/* An empty group is one dashed slot, the shape its first row will fill; why it is empty is behind the heading's "?". */}
        {group.name === FILES && !query && group.items.length === 0 && <p className="palette-empty"><Folder size={13} aria-hidden="true" />None yet</p>}
        {group.name === MEMORY && !query && group.items.length === 0 && !capabilitiesLoading && <p className="palette-empty"><Box size={13} aria-hidden="true" />None yet</p>}
        {group.name === SKILLS && !query && group.items.length === 0 && !capabilitiesLoading && <p className="palette-empty"><Puzzle size={13} aria-hidden="true" />None yet</p>}
        {group.name === SKILLS && !query && <a className="palette-hint palette-build-agent" href="/skills">Manage skills</a>}
      </>, EXPLAIN[group.name])
    })}
    {query && groups.every(group => !group.items.some(item => matches(`${item.name} ${item.detail}`))) && <p className="palette-hint">Nothing matches “{query}”.</p>}
    </div>
    {onResize && <PaletteResizer width={width ?? PALETTE_WIDTH.default} onResize={onResize} />}
  </aside>
}
