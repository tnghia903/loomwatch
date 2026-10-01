import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical, Library as LibraryIcon, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { DetectedHarness } from '../../lib/harnesses'
import { KNOWN_HARNESSES, knownHarness } from '../../lib/harnesses'
import { ENDPOINT_SOURCES, OPERATOR_SOURCE, PRESET_SOURCES } from '../../lib/library/fixtures'
import type { CapabilityInventory, DetectedCapability } from '../../lib/library/client'
import { KIND_LABEL, RELATION, type CapabilityDragPayload, type CapabilityKind } from '../../lib/composer-layout/types'
import type { LibrarySource } from '../../lib/library/types'
import type { Evidence, EvidenceKind } from '../../lib/watch/events'
import { EntityGlyph } from '../ui/glyphs'
import { CAPABILITY_DRAG_MIME, EVIDENCE_DRAG_MIME } from './constants'
import { LibraryRow } from './LibraryRow'
import { usePersistedBoolean } from './usePersistedBoolean'

function harnessToSource(harness: DetectedHarness): LibrarySource {
  // The reason comes from the daemon. The client used to write "<cmd> not found on PATH" for
  // every unavailable harness, which is wrong whenever the binary is installed and simply has
  // no ACP bridge — the daemon knows which case it is, so it says so.
  return { group: 'detected', id: harness.id, label: harness.name, spawn: harness.spawn,
    ...(harness.acpAvailable === false
      ? { unavailableReason: harness.unavailableReason ?? `${harness.spawn.cmd} not found on PATH` }
      : {}),
  }
}

function matchesFilter(source: LibrarySource, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${source.label} ${source.spawn.cmd} ${source.model ?? ''} ${source.role ?? ''}`.toLowerCase().includes(needle)
}

export interface LibraryProps {
  harnesses: DetectedHarness[]
  /** PATH entries the daemon scanned, shown behind "Show search path" (§4.2). */
  harnessSearchPath?: readonly string[]
  /** Harness ids the daemon looked for; the "Not installed" group is this list minus what it found. */
  knownHarnessIds?: readonly string[]
  harnessesLoading: boolean
  harnessesError: string | null
  onRetry?: () => void
  capabilityInventory?: CapabilityInventory
  capabilitiesLoading?: boolean
  capabilitiesError?: string | null
  capabilitiesScannedAt?: Date | null
  onRetryCapabilities?: () => void
  onInspectCapability?: (item: DetectedCapability, kind: CapabilityKind) => void
  onDragStateChange?: (dragging: boolean) => void
  observedEvidence?: readonly Evidence[]
  onRevealEvidence?: (id: string) => void
  /** Run/replay view prioritizes observed capabilities without overwriting compose preferences. */
  evidenceMode?: boolean
  /** Lets the shell keep bottom chrome clear of the panel (UX_REDESIGN §3). */
  onCollapsedChange?: (collapsed: boolean) => void
}

// UX_REDESIGN §4 / TNG-123/124: the capability library. Search, collapsible groups with
// visible/total counts, 44 px rows, a loading skeleton (no spinner in a list), errors verbatim,
// and a 48 px rail when collapsed (⌘\). Only what the daemon actually found is listed.
export function Library({ harnesses, harnessSearchPath = [], knownHarnessIds = [], harnessesLoading, harnessesError, onRetry, capabilityInventory = { skills: [], tools: [], sources: [] }, capabilitiesLoading = false, capabilitiesError = null, capabilitiesScannedAt = null, onRetryCapabilities, onInspectCapability, onDragStateChange, onCollapsedChange, observedEvidence = [], onRevealEvidence, evidenceMode = false }: LibraryProps) {
  const [persistedCollapsed, setPersistedCollapsed] = usePersistedBoolean('rail-collapsed', false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = usePersistedBoolean('detected-open', true)
  const [presetsOpen, setPresetsOpen] = usePersistedBoolean('presets-open', true)
  const [runAgentsOpen, setRunAgentsOpen] = useState(false)
  const [runPresetsOpen, setRunPresetsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = usePersistedBoolean('skills-open', true)
  const [toolsOpen, setToolsOpen] = usePersistedBoolean('tools-open', true)
  const [sourcesOpen, setSourcesOpen] = usePersistedBoolean('sources-open', true)
  const [notInstalledOpen, setNotInstalledOpen] = usePersistedBoolean('not-installed-open', false)
  const [searchPathOpen, setSearchPathOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [compactWindow, setCompactWindow] = useState(() => window.innerWidth < 1024)
  const [scrollState, setScrollState] = useState({ up: false, down: false })
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onResize = () => setCompactWindow(window.innerWidth < 1024)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // §13: at tablet widths the Library is a rail that opens as a sheet; that state is
  // per-session, so a narrow window never persists a collapse the wide window inherits.
  const railCollapsed = compactWindow ? !sheetOpen : persistedCollapsed
  const setRailCollapsed = useCallback((collapsed: boolean) => {
    if (compactWindow) setSheetOpen(!collapsed)
    else setPersistedCollapsed(collapsed)
  }, [compactWindow, setPersistedCollapsed])
  useEffect(() => { onCollapsedChange?.(railCollapsed || compactWindow) }, [railCollapsed, compactWindow, onCollapsedChange])

  useEffect(() => {
    const close = () => setRailCollapsed(true)
    const toggle = () => {
      if (railCollapsed) window.dispatchEvent(new Event('loomwatch:open-library'))
      setRailCollapsed(!railCollapsed)
    }
    window.addEventListener('loomwatch:close-library', close)
    window.addEventListener('loomwatch:toggle-library', toggle)
    return () => {
      window.removeEventListener('loomwatch:close-library', close)
      window.removeEventListener('loomwatch:toggle-library', toggle)
    }
  }, [railCollapsed, setRailCollapsed])

  const detectedSources = useMemo(() => harnesses.map(harnessToSource), [harnesses])
  // What the daemon looked for, minus what it found. Falling back to the client's own table keeps
  // the disclosure working against a daemon too old to report `knownIds`.
  const notInstalled = useMemo(() => {
    const ids = knownHarnessIds.length > 0 ? knownHarnessIds : KNOWN_HARNESSES.map((known) => known.id)
    return ids.filter((id) => !harnesses.some((h) => h.id === id)).map(knownHarness)
  }, [harnesses, knownHarnessIds])
  const filteredDetected = detectedSources.filter((source) => matchesFilter(source, query))
  const filteredPresets = [...PRESET_SOURCES, ...ENDPOINT_SOURCES].filter((source) => matchesFilter(source, query))
  const observedGroups = useMemo(() => ({
    skills: observedCapabilities(observedEvidence, ['skill']),
    tools: observedTools(observedEvidence),
    sources: observedCapabilities(observedEvidence, ['source']),
  }), [observedEvidence])
  const filteredObserved = useMemo(() => ({
    skills: observedGroups.skills.filter((item) => matchesObserved(item, query)),
    tools: observedGroups.tools.filter((item) => matchesObserved(item, query)),
    sources: observedGroups.sources.filter((item) => matchesObserved(item, query)),
  }), [observedGroups, query])
  const filteredCapabilities = useMemo(() => ({
    skills: capabilityInventory.skills.filter((item) => matchesCapability(item, query)),
    tools: capabilityInventory.tools.filter((item) => matchesCapability(item, query)),
    sources: capabilityInventory.sources.filter((item) => matchesCapability(item, query)),
  }), [capabilityInventory, query])
  const searching = query.trim().length > 0
  const agentsExpanded = searching || (evidenceMode ? runAgentsOpen : agentsOpen)
  const presetsExpanded = searching || (evidenceMode ? runPresetsOpen : presetsOpen)
  const usable = detectedSources.filter((source) => !source.unavailableReason).length + PRESET_SOURCES.length + ENDPOINT_SOURCES.length
  const total = detectedSources.length + PRESET_SOURCES.length + ENDPOINT_SOURCES.length

  const updateScrollFade = () => {
    const element = scrollRef.current
    if (!element) return
    setScrollState({ up: element.scrollTop > 4, down: element.scrollTop + element.clientHeight < element.scrollHeight - 4 })
  }
  useEffect(() => { updateScrollFade() }, [filteredDetected.length, filteredPresets.length, filteredObserved.skills.length, filteredObserved.tools.length, filteredObserved.sources.length, filteredCapabilities.skills.length, filteredCapabilities.tools.length, filteredCapabilities.sources.length, agentsExpanded, presetsExpanded, skillsOpen, toolsOpen, sourcesOpen, notInstalledOpen, railCollapsed])

  const openLibrary = () => {
    if (compactWindow) window.dispatchEvent(new Event('loomwatch:open-library'))
    setRailCollapsed(false)
  }

  if (railCollapsed) {
    return (
      <div role="toolbar" aria-label="Library, collapsed" className="panel left top e1 lw-library collapsed" style={{ pointerEvents: 'auto' }}>
        <div className="rail-only">
          <button type="button" className="iconbtn" aria-label="Expand Library" title="Expand library (⌘\)" onClick={openLibrary}><ChevronRight size={16} aria-hidden="true" /></button>
          {detectedSources.slice(0, 4).map((source) => (
            <button key={source.id} type="button" className="monogram" style={{ border: 0, cursor: 'pointer' }} aria-label={`${source.label} — expand the Library`} title={source.label} onClick={() => { openLibrary(); setAgentsOpen(true) }}>
              {knownHarness(source.id).monogram}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      {compactWindow && <button type="button" className="library-scrim lw-scrim dim" aria-label="Close Library" onClick={() => setRailCollapsed(true)} style={{ pointerEvents: 'auto', zIndex: 39 }} />}
      <section role="region" aria-label="Library" className="panel left top e1 lw-library library-sheet" style={{ pointerEvents: 'auto' }}>
        <div className="lib-brand" aria-label="LoomWatch">
          <img src="/icon.svg" alt="" width="36" height="36" />
          <span><strong className="t-title">LoomWatch</strong><small className="t-meta">Build AI agent pipelines, locally</small></span>
        </div>
        <header className="lib-head">
          <span className="lib-title"><LibraryIcon size={19} aria-hidden="true" /><span className="t-title lib-head-text">Library</span></span>
          <span className="lib-scan">
            {onRetryCapabilities && <button type="button" className="link t-ui" onClick={onRetryCapabilities} disabled={capabilitiesLoading}><RefreshCw size={14} aria-hidden="true" /> {capabilitiesLoading ? 'Scanning…' : 'Scan again'}</button>}
            <button type="button" className="iconbtn" aria-label="Collapse Library" title="Collapse library (⌘\)" onClick={() => setRailCollapsed(true)}><ChevronLeft size={16} aria-hidden="true" /></button>
          </span>
        </header>
        <div className="lib-scan-status t-meta" role="status"><span>{capabilitiesLoading ? 'Checking this Mac…' : capabilitiesScannedAt ? 'Last scanned just now' : 'Local capability scan'}</span><i className={capabilitiesError ? 'scan-dot error' : 'scan-dot'} aria-hidden="true" /></div>
        <div className="lib-controls">
          <label className="lib-search">
            <Search size={14} aria-hidden="true" />
            <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills, tools, knowledge…" aria-label="Search the Library" autoComplete="off" />
          </label>
        </div>

        <div ref={scrollRef} className={`lib-scroll ${scrollState.up ? 'can-scroll-up' : ''} ${scrollState.down ? 'can-scroll-down' : ''}`} onScroll={updateScrollFade}>
          {capabilitiesError && !capabilitiesLoading && (
            <div className="inline-error" role="alert">
              <span className="msg t-body">Couldn't scan local capabilities.</span>
              <span className="detail t-meta">{capabilitiesError}</span>
              {onRetryCapabilities && <span><button type="button" className="btn" onClick={onRetryCapabilities}>Try again</button></span>}
            </div>
          )}

          <CapabilityGroup label="Skills" kind="skill" items={filteredCapabilities.skills} observed={filteredObserved.skills} total={capabilityInventory.skills.length} open={skillsOpen} searching={searching} onToggle={() => setSkillsOpen(!skillsOpen)} loading={capabilitiesLoading} onDragStateChange={onDragStateChange} onInspect={onInspectCapability} onReveal={onRevealEvidence} />
          <CapabilityGroup label="Tools & connectors" kind="tool" items={filteredCapabilities.tools} observed={filteredObserved.tools} total={capabilityInventory.tools.length} open={toolsOpen} searching={searching} onToggle={() => setToolsOpen(!toolsOpen)} loading={capabilitiesLoading} onDragStateChange={onDragStateChange} onInspect={onInspectCapability} onReveal={onRevealEvidence} />
          <CapabilityGroup label="Knowledge sources" kind="knowledge" items={filteredCapabilities.sources} observed={filteredObserved.sources} total={capabilityInventory.sources.length} open={sourcesOpen} searching={searching} onToggle={() => setSourcesOpen(!sourcesOpen)} loading={capabilitiesLoading} onDragStateChange={onDragStateChange} onInspect={onInspectCapability} onReveal={onRevealEvidence} />

          <section className="lib-group" aria-label="Agents">
            <div className="lib-group-head">
              <button type="button" className="lib-chev t-micro" onClick={() => evidenceMode ? setRunAgentsOpen(!runAgentsOpen) : setAgentsOpen(!agentsOpen)} aria-expanded={agentsExpanded}>{agentsExpanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} Agents</button>
              <span className="lib-count">{searching ? `${filteredDetected.length}/${detectedSources.length}` : detectedSources.length}</span>
            </div>
            {agentsExpanded && (
              <div role="list" className="lib-rows">
                {harnessesLoading && [40, 52, 36].map((width) => (
                  <div key={width} className="skel-row" aria-hidden="true"><span className="skel-sq" /><span className="skel-bars"><i className="skel-bar" style={{ width: `${width}%` }} /><i className="skel-bar" style={{ width: `${100 - width}%` }} /></span></div>
                ))}
                {harnessesLoading && <span className="visually-hidden">Looking on PATH…</span>}
                {harnessesError && !harnessesLoading && (
                  <div className="inline-error" role="alert">
                    <span className="msg t-body">Couldn't read the harness list.</span>
                    <span className="detail t-mono-sm">{harnessesError}</span>
                    {onRetry && <span><button type="button" className="btn" onClick={onRetry}>Retry</button></span>}
                  </div>
                )}
                {!harnessesLoading && !harnessesError && detectedSources.length === 0 && (
                  <EmptyState>
                    <p style={{ margin: 0 }}>No agent harnesses found on PATH.</p>
                    <SearchPathDisclosure open={searchPathOpen} onToggle={() => setSearchPathOpen((open) => !open)} knownIds={knownHarnessIds} searchPath={harnessSearchPath} />
                  </EmptyState>
                )}
                {!harnessesLoading && searching && detectedSources.length > 0 && filteredDetected.length === 0 && <EmptyState><span>No agents match “{query}”.</span></EmptyState>}
                {(!searching || 'you review stop operator'.includes(query.trim().toLowerCase())) && <LibraryRow source={OPERATOR_SOURCE} onDragStateChange={onDragStateChange} />}
                {filteredDetected.map((source) => (
                  <LibraryRow key={source.id} source={source} disabledReason={source.unavailableReason} onDragStateChange={onDragStateChange} />
                ))}
                {!searching && notInstalled.length > 0 && (
                  <div>
                    <button type="button" className="lib-chev t-meta" style={{ textTransform: 'none', letterSpacing: 0, minHeight: 32, color: 'var(--color-ink-3)' }} onClick={() => setNotInstalledOpen(!notInstalledOpen)} aria-expanded={notInstalledOpen}>
                      {notInstalledOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} Not installed <span className="lib-count">{notInstalled.length}</span>
                    </button>
                    {notInstalledOpen && (
                      <div role="list" className="lib-rows" style={{ marginTop: 6 }}>
                        {notInstalled.map((known) => (
                          <LibraryRow key={known.id} disabled source={{ group: 'detected', id: known.id, label: known.name, spawn: { cmd: '', args: [] } }} />
                        ))}
                        {/* A harness can be installed and still absent here, because the daemon
                            only searches the PATH it was started with. Naming those directories is
                            the difference between "not installed" and "not visible from here". */}
                        <SearchPathDisclosure open={searchPathOpen} onToggle={() => setSearchPathOpen((open) => !open)} knownIds={knownHarnessIds} searchPath={harnessSearchPath} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="lib-group" aria-label="Role presets">
            <div className="lib-group-head">
              <button type="button" className="lib-chev t-micro" onClick={() => evidenceMode ? setRunPresetsOpen(!runPresetsOpen) : setPresetsOpen(!presetsOpen)} aria-expanded={presetsExpanded}>{presetsExpanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} Presets</button>
              <span className="lib-count">{searching ? `${filteredPresets.length}/${PRESET_SOURCES.length + ENDPOINT_SOURCES.length}` : PRESET_SOURCES.length + ENDPOINT_SOURCES.length}</span>
            </div>
            {presetsExpanded && (
              <div role="list" className="lib-rows">
                {filteredPresets.length === 0 ? (
                  <EmptyState>
                    <span>{searching ? `No presets match “${query}”.` : 'No saved presets. Add an installed agent and edit its role and model in the Inspector.'}</span>
                  </EmptyState>
                ) : filteredPresets.map((source) => <LibraryRow key={source.id} source={source} disabledReason={source.unavailableReason} onDragStateChange={onDragStateChange} />)}
              </div>
            )}
          </section>
        </div>

        <footer className="lib-foot">
          <span className="t-meta">{harnessesLoading ? 'Scanning PATH for agents…' : `${usable} of ${total} usable here`}</span>
          <span className="t-meta">Only names and compatibility are scanned; private contents stay local.</span>
        </footer>
      </section>
    </>
  )
}

/** §4.2: "we looked here, for these" — the only honest answer to a harness that is installed but
 * missing from the list, because the daemon searches the PATH it was started with and nothing else. */
function SearchPathDisclosure({ open, onToggle, knownIds, searchPath }: { open: boolean; onToggle: () => void; knownIds: readonly string[]; searchPath: readonly string[] }) {
  const ids = knownIds.length > 0 ? knownIds : KNOWN_HARNESSES.map((known) => known.id)
  return (
    <>
      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={onToggle} aria-expanded={open}>
        {open ? 'Hide search path' : 'Show search path'}
      </button>
      {open && (
        <div className="t-mono-sm" style={{ margin: 0, display: 'grid', gap: 4 }}>
          <p style={{ margin: 0 }}>Looked for {ids.join(', ')} on the PATH loomwatchd was started with.</p>
          {searchPath.length === 0
            ? <p style={{ margin: 0, color: 'var(--color-ink-3)' }}>The daemon reported no search path at all, so it was started without a PATH.</p>
            : <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--color-ink-3)' }}>{searchPath.map((directory) => <li key={directory}>{directory}</li>)}</ol>}
        </div>
      )}
    </>
  )
}

function matchesCapability(item: DetectedCapability, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || `${item.name} ${item.source} ${item.detail} ${item.status}`.toLowerCase().includes(needle)
}

function CapabilityGroup({ label, kind, items, observed, total, open, searching, onToggle, loading, onDragStateChange, onInspect, onReveal }: {
  label: string
  kind: CapabilityKind
  items: DetectedCapability[]
  observed: ObservedCapability[]
  total: number
  open: boolean
  searching: boolean
  onToggle: () => void
  loading: boolean
  onDragStateChange?: (dragging: boolean) => void
  onInspect?: (item: DetectedCapability, kind: CapabilityKind) => void
  onReveal?: (id: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const expanded = open || searching
  const observedOnly = observed.filter((event) => !items.some((item) => item.name.toLowerCase() === event.name.toLowerCase()))
  const visible = searching || showAll ? items : items.slice(0, 2)
  const hidden = Math.max(0, items.length - visible.length)
  return (
    <section className="lib-group capability-group" aria-label={label}>
      <div className="lib-group-head">
        <button type="button" className="lib-chev t-body-m" onClick={onToggle} aria-expanded={expanded}>{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />} {label}</button>
        <span className="lib-count">{searching ? `${items.length}/${total}` : total}</span>
      </div>
      {expanded && <div role="list" className="lib-rows">
        {loading && total === 0 && [44, 58].map((width) => <div key={width} className="skel-row" aria-hidden="true"><span className="skel-sq" /><span className="skel-bars"><i className="skel-bar" style={{ width: `${width}%` }} /><i className="skel-bar" style={{ width: `${100 - width}%` }} /></span></div>)}
        {!loading && visible.length === 0 && observedOnly.length === 0 && <EmptyState><span>Nothing detected in this category yet.</span></EmptyState>}
        {visible.map((item) => <MachineCapabilityRow key={item.id} item={item} kind={kind} onDragStateChange={onDragStateChange} onInspect={onInspect} />)}
        {observedOnly.map((item) => <ObservedCapabilityRow key={`${item.kind}:${item.name}`} item={item} onDragStateChange={onDragStateChange} onReveal={onReveal} />)}
        {!searching && hidden > 0 && <button type="button" className="lib-more t-meta" onClick={() => setShowAll(true)}>Show {hidden} more {label.toLowerCase().replace(' & connectors', '')}…</button>}
        {!searching && showAll && items.length > 2 && <button type="button" className="lib-more t-meta" onClick={() => setShowAll(false)}>Show less</button>}
      </div>}
    </section>
  )
}

/** Capability rows remain true drag sources, while click/keyboard opens their details. The
 * details panel owns the explicit “Add to canvas” action so inspection never mutates the plan. */
function MachineCapabilityRow({ item, kind, onDragStateChange, onInspect }: { item: DetectedCapability; kind: CapabilityKind; onDragStateChange?: (dragging: boolean) => void; onInspect?: (item: DetectedCapability, kind: CapabilityKind) => void }) {
  const compatible = item.status !== 'Local only'
  const memory = item.memory
  const payload: CapabilityDragPayload = {
    kind, name: item.name, source: item.source,
    ...(memory ? { memory: { team: memory.team, pack: memory.pack } } : {}),
  }
  const inspect = () => onInspect?.(item, kind)
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-label={`${item.name}, ${KIND_LABEL[kind].toLowerCase()} from ${item.source}, click for details or drag onto the canvas`}
      title={`${item.detail}\n\nClick for details, or drag onto the canvas`}
      className="lib-row capability-row"
      onDragStart={(event) => {
        event.dataTransfer.setData(CAPABILITY_DRAG_MIME, JSON.stringify(payload))
        event.dataTransfer.setData('text/plain', item.name)
        event.dataTransfer.effectAllowed = 'copy'
        onDragStateChange?.(true)
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      onClick={inspect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect() } }}
    >
      {/* Team memory gets its own mark, "◫", because it is not the same thing as a connected
          wiki or a previous session's context: it is another team's writing, and the design gives
          it a distinct monogram so a glance at the group tells them apart. */}
      <span className="monogram res">
        {memory ? <span aria-hidden="true">◫</span> : <EntityGlyph kind={kind === 'knowledge' ? 'source' : kind} size={12} />}
      </span>
      <span className="lib-row-text">
        <span className="lib-row-name t-body-m">{item.name}</span>
        <span className="lib-row-sub t-meta">{item.source}</span>
        <span className="lib-row-meta t-meta"><span className="lib-row-compat">{KIND_LABEL[kind].toLowerCase()} · {RELATION[kind]}</span></span>
      </span>
      <span className="cap-status t-meta"><i className={compatible ? 'ready-dot' : 'ready-dot local'} aria-hidden="true" />{item.status}</span>
      <GripVertical className="drag-dots" size={16} aria-hidden="true" />
    </div>
  )
}

interface ObservedCapability {
  id: string
  name: string
  kind: EvidenceKind
  detail: string
  count: number
}

function observedCapabilities(evidence: readonly Evidence[], kinds: readonly EvidenceKind[]): ObservedCapability[] {
  const items = new Map<string, ObservedCapability>()
  for (const item of evidence) {
    if (!kinds.includes(item.kind)) continue
    const key = `${item.kind}:${item.name}`
    const existing = items.get(key)
    if (existing) existing.count += 1
    else items.set(key, { id: item.id, name: item.name, kind: item.kind, detail: item.detail, count: 1 })
  }
  return [...items.values()]
}

function observedTools(evidence: readonly Evidence[]): ObservedCapability[] {
  const items = new Map<string, ObservedCapability>()
  for (const item of evidence) {
    if (!item.callId || item.kind === 'skill') continue
    const call = item.events.find((event) => event.kind === 'tool_call')
    const rawName = typeof call?.payload.name === 'string' ? call.payload.name : null
    const mcp = rawName ? /^mcp__([^_]+)__(.+)$/.exec(rawName) : null
    const fallbackName = item.kind === 'search' && /^Search\s+["“]/.test(item.name)
      ? 'Web search'
      : item.kind === 'source' && /^Fetch\s+https?:/i.test(item.name)
        ? 'Web fetch'
        : item.name
    const name = mcp ? `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}` : rawName ?? fallbackName
    const key = name.toLowerCase()
    const existing = items.get(key)
    if (existing) existing.count += 1
    else items.set(key, { id: item.id, name, kind: 'tool', detail: item.toolKind ? `${item.toolKind} · recorded tool` : 'recorded tool', count: 1 })
  }
  return [...items.values()]
}

function matchesObserved(item: ObservedCapability, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || `${item.name} ${item.kind} ${item.detail}`.toLowerCase().includes(needle)
}

function ObservedCapabilityRow({ item, onDragStateChange, onReveal }: { item: ObservedCapability; onDragStateChange?: (dragging: boolean) => void; onReveal?: (id: string) => void }) {
  const kind = item.kind === 'delegation' || item.kind === 'permission' ? 'tool' : item.kind
  return (
    <div role="button" tabIndex={0} draggable aria-label={`${item.name}, recorded ${kind}; drag onto the canvas to reposition or press Enter to reveal it`} title="Drag onto the canvas to reposition the recorded card" className="lib-row"
      onDragStart={(event) => {
        event.dataTransfer.setData(EVIDENCE_DRAG_MIME, item.id)
        event.dataTransfer.setData('text/plain', item.name)
        event.dataTransfer.effectAllowed = 'move'
        onDragStateChange?.(true)
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      onClick={() => onReveal?.(item.id)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onReveal?.(item.id) } }}>
      <span className="monogram res"><EntityGlyph kind={kind} size={11} /></span>
      <span className="lib-row-text">
        <span className="lib-row-name t-body-m">{item.name}</span>
        <span className="lib-row-sub t-mono-sm">{item.detail || `recorded ${kind}`}</span>
        <span className="lib-row-meta t-meta"><span className="lbadge wired">Observed{item.count > 1 ? ` ×${item.count}` : ''}</span></span>
      </span>
      <GripVertical className="drag-dots" size={16} aria-hidden="true" />
    </div>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="lib-empty t-meta">{children}</div>
}
