import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookmarkCheck, Bot, Box, ChartColumn, Code2, Globe, GripVertical, Info, PanelLeftClose, PanelLeftOpen, PenLine, Plus, Puzzle, RefreshCw, ScanEye, Scissors, Search, Shapes, Telescope, Trash2, UserCheck, Wrench, type LucideIcon } from 'lucide-react'
import { harnessProblem, KNOWN_HARNESSES, knownHarness } from '../../lib/harnesses'
import { OPERATOR_SOURCE } from '../../lib/library/fixtures'
import { removeJob, savedJobPreset, useSavedJobs } from '../../lib/library/jobs'
import { usedInRun, type UsedInRun } from '../../lib/library/observed'
import { harnessForRole, ROLE_PRESETS, roleSource, type RoleIcon, type RolePreset } from '../../lib/library/roles'
import type { CapabilityInventory, DetectedCapability } from '../../lib/library/client'
import type { CapabilityDragPayload, CapabilityKind } from '../../lib/composer-layout/types'
import type { DetectedHarness } from '../../lib/harnesses'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import type { Evidence } from '../../lib/watch/events'
import { CAPABILITY_DRAG_MIME, EVIDENCE_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'
import { AddSource, type ChosenSource } from '../canvas/AddSource'

const ROLE_ICONS: Record<RoleIcon, LucideIcon> = { research: Telescope, write: PenLine, edit: Scissors, review: ScanEye, code: Code2, design: Shapes, analyse: ChartColumn }

const USED = 'Used in this run'
const BUILT_IN = 'Hire by job'
const YOURS = 'Your jobs'
const APPS = 'AI apps'

export interface LibraryProps {
  harnesses: DetectedHarness[]
  /** PATH entries the daemon scanned, shown behind "Show search path" (§4.2). */
  harnessSearchPath?: readonly string[]
  /** Harness ids the daemon looked for; "Not installed" is this list minus what it found. */
  knownHarnessIds?: readonly string[]
  harnessesLoading: boolean
  harnessesError: string | null
  onRetry?: () => void
  capabilityInventory?: CapabilityInventory
  capabilitiesLoading?: boolean
  capabilitiesError?: string | null
  capabilitiesScannedAt?: Date | null
  onRetryCapabilities?: () => void
  /** A skill, tool or knowledge row's details, which also connect it to agents. */
  onInspectCapability?: (item: DetectedCapability, kind: CapabilityKind) => void
  onDragStateChange?: (dragging: boolean) => void
  /** Lets the shell keep its layout clear of the panel. */
  onCollapsedChange?: (collapsed: boolean) => void
  /** The run on screen's recorded evidence; empty in Build. */
  observedEvidence?: readonly Evidence[]
  onRevealEvidence?: (id: string) => void
  /** Agent ids to the names on their cards, for "Used in this run". */
  agentNames?: ReadonlyMap<string, string>
  /** The open team file, which an added file is copied beside. */
  teamPath?: string | null
  /** Put folders and files the operator chose on the canvas as cards (ADR 0042). Absent when the team cannot be edited. */
  onAddSources?: (sources: ChosenSource[]) => void
}

interface PaletteItem {
  name: string
  detail: string
  /** A third line: the app a job runs on, or a capability's compatibility. */
  engine?: string
  quiet?: boolean
  Icon: LucideIcon
  mime: string
  event: string
  disabled: boolean
  payload: object
  /** A saved job's id: the row offers to remove it. */
  jobId?: string
  /** A skill, tool or knowledge source: the row offers its details. */
  capability?: { item: DetectedCapability; kind: CapabilityKind }
}

function jobItem(preset: RolePreset, harnesses: readonly DetectedHarness[], jobId?: string): PaletteItem {
  const harness = harnessForRole(preset, harnesses)
  return { name: preset.label, detail: preset.does, engine: harness ? `on ${harness.name}` : 'needs an AI app', Icon: preset.icon ? ROLE_ICONS[preset.icon] : BookmarkCheck, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: !harness, payload: (roleSource(preset, harnesses) ?? {}) as object, ...(jobId ? { jobId } : {}) }
}

function capabilityItem(item: DetectedCapability, kind: CapabilityKind): PaletteItem {
  const payload: CapabilityDragPayload = { kind, name: item.name, source: item.source, ...(item.memory ? { memory: { team: item.memory.team, pack: item.memory.pack } } : {}) }
  return { name: item.name, detail: item.source, engine: item.status, quiet: item.status === 'Local only', Icon: kind === 'skill' ? Puzzle : kind === 'tool' ? Wrench : Box, mime: CAPABILITY_DRAG_MIME, event: 'loomwatch:add-capability', disabled: false, payload, capability: { item, kind } }
}

const listOf = (names: readonly string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/** "Built into the app · Researcher and Fact-checker" — what it is, and who used it. */
function usedDetail(row: UsedInRun, name: (id: string) => string): string {
  const origin = { app: 'Built into the app', connected: 'Connected tool', team: 'LoomWatch', skill: 'Skill' }[row.origin]
  return `${origin} · ${listOf(row.agents.map((agent) => name(agent.id)))}`
}

/** Why a call did not go through, in the words of the switch that would let it (ADR 0037). */
function usedRefusal(row: UsedInRun, name: (id: string) => string): string | null {
  if (row.refused === 0) return null
  const declined = `Declined ${row.refused}×`
  const doing = ALLOW_SWITCHES.find((item) => item.key === row.allow)?.label
  if (!doing) return declined
  const who = row.refusedBy.map(name)
  return `${declined}: ${listOf(who)} ${who.length === 1 ? 'isn’t' : 'aren’t'} allowed to ${doing.charAt(0).toLowerCase()}${doing.slice(1)}`
}

/**
 * The one add panel, in Build and in a run's full trace (ADR 0041): what you can add — jobs, AI
 * apps, skills, tools, knowledge — and, while a run is shown, what that run used. It replaced a
 * second "Library" that the trace drew with other groups, other rows and other words for the
 * same skills and tools.
 */
export function ComponentPalette({ harnesses, harnessSearchPath = [], knownHarnessIds = [], harnessesLoading, harnessesError, onRetry, capabilityInventory, capabilitiesLoading = false, capabilitiesError = null, capabilitiesScannedAt = null, onRetryCapabilities, onInspectCapability, onDragStateChange, onCollapsedChange, observedEvidence = [], onRevealEvidence, agentNames, teamPath, onAddSources }: LibraryProps) {
  // On a phone the panel would take half the screen, so it starts closed and overlays the canvas
  // when opened; adding something closes it again so the new card is in view.
  const narrow = () => typeof window !== 'undefined' && window.innerWidth < 768
  const [collapsed, setCollapsed] = useState(narrow)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [notInstalledOpen, setNotInstalledOpen] = useState(false)
  const [searchPathOpen, setSearchPathOpen] = useState(false)
  // A saved job is removed on a second click, so one stray click never loses it.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const saved = useSavedJobs()
  const used = useMemo(() => usedInRun(observedEvidence), [observedEvidence])
  const agentName = (id: string) => agentNames?.get(id) ?? id
  useEffect(() => { onCollapsedChange?.(collapsed) }, [collapsed, onCollapsedChange])
  const expand = () => {
    setCollapsed(false)
    window.dispatchEvent(new Event('loomwatch:open-library'))
  }
  // Something else needs the canvas for a moment — an Ask proposal to review, a run to read, an
  // inspector at tablet width — so the panel folds; ⌘\ toggles it.
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
  // What the daemon looked for, minus what it found: the difference between "not installed" and
  // "installed but not visible from the PATH the daemon was started with".
  const notInstalled = useMemo(() => {
    const ids = knownHarnessIds.length > 0 ? knownHarnessIds : KNOWN_HARNESSES.map((known) => known.id)
    return ids.filter((id) => !harnesses.some((harness) => harness.id === id)).map((id) => knownHarness(id).name)
  }, [harnesses, knownHarnessIds])

  const builtIn = { name: BUILT_IN, items: [
    // Jobs first: a newcomer knows they need a researcher, not which app to run one on. Each job is
    // placed with working instructions on the best installed app, which stays changeable in its
    // settings. "You" is the review step that pauses the team for the operator's approval.
    ...ROLE_PRESETS.map(preset => jobItem(preset, harnesses)),
    { name: 'You (review step)', detail: 'Pause so you can approve the work', Icon: UserCheck, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: false, payload: OPERATOR_SOURCE as object },
  ] }
  // The operator's own jobs, saved from agents that worked (ADR 0030). Once there are any they lead
  // the list: someone who saved a job comes back for it more than for a built-in one.
  const yours = { name: YOURS, items: saved.jobs.map(job => jobItem(savedJobPreset(job), harnesses, job.id)) }
  const groups: { name: string; items: PaletteItem[] }[] = [
    ...(yours.items.length || saved.problems.length ? [yours, builtIn] : [builtIn]),
    // The same agents without a job: an app and an empty brief, for operators who write their own.
    { name: APPS, items: [
      // An app that last failed to start stays addable — the operator may have just fixed it, and
      // placing it asks for its models again — but it says why it may not run instead of "AI agent".
      ...harnesses.map(h => ({ name: h.name, detail: harnessProblem(h) ?? 'Blank agent · you write its brief', Icon: Bot, mime: LIBRARY_DRAG_MIME, event: 'loomwatch:add-agent', disabled: h.acpAvailable === false, payload: { group: 'detected', id: h.id, label: h.name, spawn: h.spawn } as object })),
    ] },
    ...(['skills', 'tools', 'sources'] as const).map(key => {
      const kind: CapabilityKind = key === 'skills' ? 'skill' : key === 'tools' ? 'tool' : 'knowledge'
      return { name: { skills: 'Skills', tools: 'Tools', sources: 'Knowledge' }[key], items: (capabilityInventory?.[key] ?? []).map(item => capabilityItem(item, kind)) }
    }),
  ]
  // The agent lists are short and are what a new team needs, so they are shown whole; the
  // capability groups can run to hundreds of entries and fold to three.
  const limitFor = (group: string) => (group === BUILT_IN ? 8 : group === YOURS ? 6 : group === APPS ? 4 : group === USED ? 6 : 3)
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase())
  const remove = (item: PaletteItem) => {
    if (!item.jobId) return
    if (confirmRemove !== item.jobId) { setConfirmRemove(item.jobId); return }
    setConfirmRemove(null)
    setRemoveError(null)
    removeJob(item.jobId).catch((error: unknown) => setRemoveError(error instanceof Error ? error.message : String(error)))
  }
  const row = (item: PaletteItem, i: number) => {
    const add = <button key={`${item.name}-${i}`} className="palette-item" disabled={item.disabled} title={item.engine ? `${item.detail} · ${item.engine}` : item.detail} draggable={!item.disabled} onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(item.mime, JSON.stringify(item.payload)); e.dataTransfer.setData('text/plain', item.name); onDragStateChange?.(true) }} onDragEnd={() => onDragStateChange?.(false)} onClick={() => { window.dispatchEvent(new CustomEvent(item.event, { detail: JSON.stringify(item.payload) })); if (narrow()) setCollapsed(true) }}><GripVertical size={13} /><span className="palette-icon"><item.Icon size={15} /></span><span><strong>{item.name}</strong><small>{item.detail}</small>{item.engine && <em className={item.quiet ? 'palette-engine quiet' : 'palette-engine'}>{item.engine}</em>}</span><Plus size={13} /></button>
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
      <button className={confirming ? 'palette-job-remove confirming' : 'palette-job-remove icon-button'} onClick={() => remove(item)} onBlur={() => { if (confirming) setConfirmRemove(null) }} aria-label={confirming ? `Confirm removing ${item.name}` : `Remove the job ${item.name}`} title={confirming ? 'Click again to remove. Teams that use it keep their copy.' : 'Remove this job'}>{confirming ? 'Remove' : <Trash2 size={12} />}</button>
    </div>
  }
  const usedRow = (item: UsedInRun) => {
    const detail = usedDetail(item, agentName)
    const refusal = usedRefusal(item, agentName)
    const Icon = item.kind === 'skill' ? Puzzle : item.allow === 'web' ? Globe : Wrench
    return <button key={item.key} className="palette-item palette-used" title={`${detail}${refusal ? `\n${refusal}` : ''}\n\nClick to show it on the canvas`} draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(EVIDENCE_DRAG_MIME, item.evidenceId); e.dataTransfer.setData('text/plain', item.name); onDragStateChange?.(true) }}
      onDragEnd={() => onDragStateChange?.(false)}
      onClick={() => onRevealEvidence?.(item.evidenceId)}>
      <GripVertical size={13} /><span className="palette-icon"><Icon size={15} /></span>
      <span><strong>{item.name}</strong><small>{detail}</small>{refusal && <em className="palette-engine refused">{refusal}</em>}</span>
      <span className="palette-used-count" aria-label={`${item.calls} call${item.calls === 1 ? '' : 's'}`}>×{item.calls}</span>
    </button>
  }
  const section = (name: string, rows: ReactNode[], total: number, extra?: ReactNode) => <section key={name} aria-label={name}>
    <h3>{name}</h3>
    {rows}
    {!query && total > limitFor(name) && <button className="palette-more" onClick={() => setExpanded(current => ({ ...current, [name]: !current[name] }))}>{expanded[name] ? 'Show less' : `Show ${total - limitFor(name)} more`}</button>}
    {extra}
  </section>
  const visible = <T,>(name: string, items: readonly T[]) => items.slice(0, query || expanded[name] ? undefined : limitFor(name))

  if (collapsed) return <button className="palette-reopen" onClick={expand} title="Open the panel (⌘\)">
    <PanelLeftOpen size={16} />{used.length > 0 ? `${USED} · ${used.length}` : 'Add agents'}
  </button>
  const usedShown = used.filter(item => matches(`${item.name} ${usedDetail(item, agentName)}`))
  const scanned = capabilitiesScannedAt ? `Scanned this Mac at ${capabilitiesScannedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Scanning finds the skills and tools on this Mac'
  return <aside className="node-palette" aria-label="Add to your team" data-tour="palette">
    <div className="palette-head"><div><span className="eyebrow">Add to your team</span><p>Click + or drag onto the canvas</p></div><button className="icon-button" onClick={() => setCollapsed(true)} aria-label="Collapse the library" title="Collapse (⌘\)"><PanelLeftClose size={16} /></button></div>
    <div className="palette-search"><Search size={12} /><input aria-label="Search agents, skills and tools" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /><button className="icon-button" onClick={onRetryCapabilities} disabled={capabilitiesLoading} aria-label="Scan this computer again" title="Scan again"><RefreshCw size={12} /></button></div>
    <p className="palette-scan" role="status">{capabilitiesLoading ? 'Checking this Mac…' : scanned}</p>
    {capabilitiesError && !capabilitiesLoading && <div className="palette-alert" role="alert"><span>Couldn’t scan this Mac’s skills and tools.</span><small>{capabilitiesError}</small>{onRetryCapabilities && <button className="btn" onClick={onRetryCapabilities}>Try again</button>}</div>}
    {removeError && <p role="alert">{removeError}</p>}
    {/* A run's own record first, while one is shown: what it used, one row per tool, not per call. */}
    {used.length > 0 && usedShown.length > 0 && section(USED, visible(USED, usedShown).map(usedRow), usedShown.length,
      used.some(item => item.origin === 'app') && !query && <p className="palette-hint">Tools built into an app are not added from here. Switch them on per agent, under <b>Allowed without asking</b>.</p>)}
    {groups.map(group => {
      const items = group.items.filter(item => matches(`${item.name} ${item.detail}`))
      if (query && items.length === 0) return null
      const loadingApps = group.name === APPS && harnessesLoading
      const loadingCapabilities = (group.name === 'Skills' || group.name === 'Tools' || group.name === 'Knowledge') && capabilitiesLoading && group.items.length === 0
      return section(group.name, [
        ...(loadingApps || loadingCapabilities ? [40, 56].map(width => <div key={width} className="skel-row" aria-hidden="true"><span className="skel-sq" /><span className="skel-bars"><i className="skel-bar" style={{ width: `${width}%` }} /><i className="skel-bar" style={{ width: `${100 - width}%` }} /></span></div>) : []),
        ...visible(group.name, items).map(row),
      ], items.length, <>
        {group.name === BUILT_IN && !yours.items.length && !saved.problems.length && saved.available && !query && <p className="palette-hint">To reuse an agent that worked, select it and choose <b>Save as job</b>.</p>}
        {group.name === YOURS && saved.problems.map(problem => <p key={problem.file} className="palette-hint palette-problem" title={problem.message}>Can’t read {problem.file}: {problem.message}</p>)}
        {group.name === APPS && !query && <AppsFooter loading={harnessesLoading} error={harnessesError} onRetry={onRetry} found={harnesses.length} notInstalled={notInstalled} notInstalledOpen={notInstalledOpen} onToggleNotInstalled={() => setNotInstalledOpen(open => !open)} searchPathOpen={searchPathOpen} onToggleSearchPath={() => setSearchPathOpen(open => !open)} knownIds={knownHarnessIds} searchPath={harnessSearchPath} />}
        {group.name === 'Tools' && !query && <p className="palette-hint">Web search, commands and file edits are built into each AI app. Switch them on per agent, under <b>Allowed without asking</b>.</p>}
        {group.name === 'Knowledge' && !query && onAddSources && <AddSource teamPath={teamPath} onAdd={(sources) => { onAddSources(sources); if (narrow()) setCollapsed(true) }} />}
        {group.name === 'Knowledge' && !query && <p className="palette-hint">{group.items.length === 0 && !capabilitiesLoading ? 'Teams with memory appear here. ' : ''}A folder or file becomes a card: connect it to every agent that should read it.</p>}
        {group.name !== 'Knowledge' && group.name !== APPS && group.name !== BUILT_IN && group.name !== YOURS && !query && group.items.length === 0 && !capabilitiesLoading && <p className="palette-hint">Nothing found on this Mac yet.</p>}
      </>)
    })}
    {query && usedShown.length === 0 && groups.every(group => !group.items.some(item => matches(`${item.name} ${item.detail}`))) && <p className="palette-hint">Nothing matches “{query}”.</p>}
    <p className="palette-foot">Only names and compatibility are scanned; private contents stay on this Mac.</p>
  </aside>
}

/** Under the apps: why the list looks the way it does — still looking, could not look, or not installed. */
function AppsFooter({ loading, error, onRetry, found, notInstalled, notInstalledOpen, onToggleNotInstalled, searchPathOpen, onToggleSearchPath, knownIds, searchPath }: {
  loading: boolean; error: string | null; onRetry?: () => void; found: number
  notInstalled: readonly string[]; notInstalledOpen: boolean; onToggleNotInstalled: () => void
  searchPathOpen: boolean; onToggleSearchPath: () => void; knownIds: readonly string[]; searchPath: readonly string[]
}) {
  if (loading) return <span className="visually-hidden">Looking for AI apps…</span>
  if (error) return <div className="palette-alert" role="alert"><span>Couldn’t read the list of AI apps.</span><small>{error}</small>{onRetry && <button className="btn" onClick={onRetry}>Retry</button>}</div>
  const disclosure = <SearchPathDisclosure open={searchPathOpen} onToggle={onToggleSearchPath} knownIds={knownIds} searchPath={searchPath} />
  if (found === 0) return <div className="palette-hint"><p>No AI apps found on this Mac.</p>{disclosure}</div>
  if (notInstalled.length === 0) return null
  return <div className="palette-hint">
    <button className="palette-more" aria-expanded={notInstalledOpen} onClick={onToggleNotInstalled}>Not installed · {notInstalled.length}</button>
    {notInstalledOpen && <><p>{notInstalled.join(', ')}</p>{disclosure}</>}
  </div>
}

/** §4.2: "we looked here, for these" — the only honest answer to an app that is installed but
 * missing from the list, because the daemon searches the PATH it was started with and nothing else. */
function SearchPathDisclosure({ open, onToggle, knownIds, searchPath }: { open: boolean; onToggle: () => void; knownIds: readonly string[]; searchPath: readonly string[] }) {
  const ids = knownIds.length > 0 ? knownIds : KNOWN_HARNESSES.map((known) => known.id)
  return <>
    <button className="palette-more" onClick={onToggle} aria-expanded={open}>{open ? 'Hide search path' : 'Show search path'}</button>
    {open && <div className="palette-path">
      <p>Looked for {ids.join(', ')} on the PATH loomwatchd was started with.</p>
      {searchPath.length === 0
        ? <p>The daemon reported no search path at all, so it was started without a PATH.</p>
        : <ol>{searchPath.map((directory) => <li key={directory}>{directory}</li>)}</ol>}
    </div>}
  </>
}
