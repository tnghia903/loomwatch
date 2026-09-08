import { ChevronDown, ChevronRight, PanelLeft, Plus, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo, useRef, useState } from 'react'

import type { DetectedHarness } from '../../lib/harnesses'
import { KNOWN_HARNESSES } from '../../lib/harnesses'
import { ENDPOINT_SOURCES, PRESET_SOURCES } from '../../lib/library/fixtures'
import type { LibrarySource } from '../../lib/library/types'
import { LibraryRow } from './LibraryRow'
import { usePersistedBoolean } from './usePersistedBoolean'

function harnessToSource(harness: DetectedHarness): LibrarySource {
  return { group: 'detected', id: harness.id, label: harness.name, spawn: harness.spawn }
}

function matchesFilter(source: LibrarySource, query: string): boolean {
  return source.label.toLowerCase().includes(query.toLowerCase())
}

interface LibraryProps {
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  harnessesError: string | null
}

export function Library({ harnesses, harnessesLoading, harnessesError }: LibraryProps) {
  const [railCollapsed, setRailCollapsed] = usePersistedBoolean(
    'rail-collapsed',
    typeof window !== 'undefined' && window.innerWidth < 1024,
  )
  const [detectedOpen, setDetectedOpen] = usePersistedBoolean('detected-open', true)
  const [endpointsOpen, setEndpointsOpen] = usePersistedBoolean('endpoints-open', true)
  const [presetsOpen, setPresetsOpen] = usePersistedBoolean('presets-open', true)
  const [notInstalledOpen, setNotInstalledOpen] = usePersistedBoolean('not-installed-open', false)
  const [searchPathOpen, setSearchPathOpen] = useState(false)
  const [query, setQuery] = useState('')

  const detectedSources = useMemo(() => harnesses.map(harnessToSource), [harnesses])
  const notInstalled = useMemo(
    () => KNOWN_HARNESSES.filter((known) => !harnesses.some((h) => h.id === known.id)),
    [harnesses],
  )

  const totalRows = detectedSources.length + ENDPOINT_SOURCES.length + PRESET_SOURCES.length
  const showFilter = totalRows > 8

  const filteredDetected = query ? detectedSources.filter((s) => matchesFilter(s, query)) : detectedSources
  const filteredEndpoints = query ? ENDPOINT_SOURCES.filter((s) => matchesFilter(s, query)) : ENDPOINT_SOURCES
  const filteredPresets = query ? PRESET_SOURCES.filter((s) => matchesFilter(s, query)) : PRESET_SOURCES

  const detectedSectionRef = useRef<HTMLDivElement>(null)
  const endpointsSectionRef = useRef<HTMLDivElement>(null)
  const presetsSectionRef = useRef<HTMLDivElement>(null)

  const expandToGroup = (group: 'detected' | 'endpoints' | 'presets') => {
    setRailCollapsed(false)
    const ref =
      group === 'detected' ? detectedSectionRef : group === 'endpoints' ? endpointsSectionRef : presetsSectionRef
    if (group === 'detected') setDetectedOpen(true)
    if (group === 'endpoints') setEndpointsOpen(true)
    if (group === 'presets') setPresetsOpen(true)
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }))
  }

  if (railCollapsed) {
    return (
      <div
        role="toolbar"
        aria-label="Library, collapsed"
        className="pointer-events-auto flex w-12 flex-col items-center gap-2 rounded-lg border border-hairline/10 bg-surface/72 py-3 shadow-[0_1px_2px_rgb(0_0_0/.04),0_8px_24px_rgb(0_0_0/.08)] backdrop-blur-xl"
      >
        <button
          type="button"
          aria-label="Expand Library"
          onClick={() => setRailCollapsed(false)}
          className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-iris/6"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Detected harnesses"
          onClick={() => expandToGroup('detected')}
          className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-iris/6"
        >
          {detectedSources.length}
        </button>
        <button
          type="button"
          aria-label="Endpoints"
          onClick={() => expandToGroup('endpoints')}
          className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-iris/6"
        >
          {ENDPOINT_SOURCES.length}
        </button>
        <button
          type="button"
          aria-label="Role presets"
          onClick={() => expandToGroup('presets')}
          className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-iris/6"
        >
          {PRESET_SOURCES.length}
        </button>
      </div>
    )
  }

  return (
    <div
      role="region"
      aria-label="Library"
      className="pointer-events-auto flex w-72 max-h-[640px] flex-col gap-3 overflow-y-auto rounded-lg border border-hairline/10 bg-surface/72 p-4 shadow-[0_1px_2px_rgb(0_0_0/.04),0_8px_24px_rgb(0_0_0/.08)] backdrop-blur-xl"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Library</span>
        <button
          type="button"
          aria-label="Collapse Library"
          onClick={() => setRailCollapsed(true)}
          className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-iris/6"
        >
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {showFilter && (
        <label className="flex h-8 items-center gap-2 rounded-md border border-hairline/10 px-2 text-[13px] text-ink-2">
          <Search className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            aria-label="Filter the Library"
            className="w-full bg-transparent text-ink outline-none placeholder:text-ink-3"
          />
        </label>
      )}

      <section ref={detectedSectionRef} aria-label="Detected harnesses">
        <SectionHeader
          label="Detected harnesses"
          count={detectedSources.length}
          open={detectedOpen}
          onToggle={() => setDetectedOpen(!detectedOpen)}
        />
        {detectedOpen && (
          <div role="list" className="flex flex-col">
            {harnessesLoading && <p className="px-2 py-2 text-[12px] text-ink-3">Looking on PATH…</p>}
            {harnessesError && !harnessesLoading && (
              <p className="px-2 py-2 text-[12px] text-red">Couldn't reach the daemon: {harnessesError}</p>
            )}
            {!harnessesLoading && !harnessesError && filteredDetected.length === 0 && detectedSources.length === 0 && (
              <EmptyState>
                <p>No agent harnesses found on PATH.</p>
                <button
                  type="button"
                  onClick={() => setSearchPathOpen((open) => !open)}
                  className="mt-1 text-left text-iris underline-offset-2 hover:underline"
                >
                  Show search path
                </button>
                {searchPathOpen && (
                  <p className="mt-1 font-mono text-[11px] text-ink-3">
                    Looked for {KNOWN_HARNESSES.map((h) => h.id).join(', ')} on the PATH loomwatchd was started
                    with.
                  </p>
                )}
              </EmptyState>
            )}
            {filteredDetected.map((source) => (
              <LibraryRow key={source.id} source={source} />
            ))}
            {!query && notInstalled.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setNotInstalledOpen(!notInstalledOpen)}
                  className="flex h-8 w-full items-center gap-1 px-2 text-[12px] text-ink-3"
                >
                  {notInstalledOpen ? (
                    <ChevronDown className="size-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  )}
                  Not installed
                  <span className="ml-auto">{notInstalled.length}</span>
                </button>
                {notInstalledOpen && (
                  <div role="list">
                    {notInstalled.map((known) => (
                      <LibraryRow
                        key={known.id}
                        disabled
                        source={{ group: 'detected', id: known.id, label: known.name, spawn: { cmd: '', args: [] } }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section ref={endpointsSectionRef} aria-label="Endpoints">
        <SectionHeader
          label="Endpoints"
          count={ENDPOINT_SOURCES.length}
          open={endpointsOpen}
          onToggle={() => setEndpointsOpen(!endpointsOpen)}
        />
        {endpointsOpen && (
          <div role="list">
            {filteredEndpoints.length === 0 && ENDPOINT_SOURCES.length === 0 ? (
              <EmptyState>
                <p>Nothing here yet. Add an endpoint to reach a model without a first-party harness.</p>
                <button
                  type="button"
                  disabled
                  title="Endpoint management isn't available yet"
                  className="mt-2 flex items-center gap-1 self-end text-ink-3 opacity-60"
                >
                  <Plus className="size-3.5" aria-hidden="true" /> Add endpoint
                </button>
              </EmptyState>
            ) : (
              filteredEndpoints.map((source) => <LibraryRow key={source.id} source={source} />)
            )}
          </div>
        )}
      </section>

      <section ref={presetsSectionRef} aria-label="Role presets">
        <SectionHeader
          label="Role presets"
          count={PRESET_SOURCES.length}
          open={presetsOpen}
          onToggle={() => setPresetsOpen(!presetsOpen)}
        />
        {presetsOpen && (
          <div role="list">
            {filteredPresets.length === 0 && PRESET_SOURCES.length === 0 ? (
              <EmptyState>
                <p>Save any node as a preset to reuse it.</p>
              </EmptyState>
            ) : (
              filteredPresets.map((source) => <LibraryRow key={source.id} source={source} />)
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function SectionHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-6 w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3"
    >
      {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
      {label}
      <span className="ml-auto">{count}</span>
    </button>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-md border border-dashed border-hairline/20 p-3 text-[12px] leading-4 text-ink-2">
      {children}
    </div>
  )
}
