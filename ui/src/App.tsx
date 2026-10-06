import { ReactFlowProvider } from '@xyflow/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'

import { Feedback } from './components/feedback/Feedback'
import { Updates } from './components/updates/Updates'
import { GettingStarted } from './components/tour/GettingStarted'
import { Workspace } from './components/Workspace'
import { type DetectedHarness, fetchHarnesses, isHarnessRunnable } from './lib/harnesses'
import { fetchCapabilities, type CapabilityInventory } from './lib/library/client'
import { useTheme } from './lib/theme'

const Connections = lazy(() => import('./components/Connections'))

function useHarnesses() {
  const [harnesses, setHarnesses] = useState<DetectedHarness[]>([])
  // Where the daemon looked, and what for. Empty until the first reply; the Library only shows
  // it on request, so an empty value never reads as "nowhere".
  const [searchedPath, setSearchedPath] = useState<string[]>([])
  const [knownIds, setKnownIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetchHarnesses()
      .then((report) => {
        if (cancelled) return
        setHarnesses(report.harnesses ?? [])
        setSearchedPath(report.searchedPath ?? [])
        setKnownIds(report.knownIds ?? [])
        setError(report.runnerError ?? null)
      })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [generation])
  const retry = useCallback(() => { setLoading(true); setGeneration((value) => value + 1) }, [])
  return { harnesses, searchedPath, knownIds, loading, error, retry }
}

function useCapabilities() {
  const [inventory, setInventory] = useState<CapabilityInventory>({ skills: [], tools: [], sources: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scannedAt, setScannedAt] = useState<Date | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetchCapabilities()
      .then((found) => {
        if (!cancelled) {
          setInventory(found)
          setScannedAt(new Date())
          setError(null)
        }
      })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [generation])
  const retry = useCallback(() => { setLoading(true); setGeneration((value) => value + 1) }, [])
  return { inventory, loading, error, scannedAt, retry }
}

function Editor({ initialRunId }: { initialRunId: string | null }) {
  const { harnesses, searchedPath, knownIds, loading, error, retry } = useHarnesses()
  const capabilities = useCapabilities()
  const [, setDocumentOpen] = useState(() => new URLSearchParams(window.location.search).has('path'))
  const readyApps = useMemo(() => harnesses.filter(isHarnessRunnable).map((harness) => harness.name), [harnesses])
  return (
    <ReactFlowProvider>
      {/* Above Home and the workspace alike: the guide carries on across the page load a new team causes. */}
      <GettingStarted readyApps={readyApps} appsLoading={loading} />
      <Feedback harnesses={harnesses} />
      <Updates />
      <Workspace
        harnesses={harnesses}
        harnessSearchPath={searchedPath}
        knownHarnessIds={knownIds}
        harnessesLoading={loading}
        harnessesError={error}
        onRetryHarnesses={retry}
        capabilityInventory={capabilities.inventory}
        capabilitiesLoading={capabilities.loading}
        capabilitiesError={capabilities.error}
        capabilitiesScannedAt={capabilities.scannedAt}
        onRetryCapabilities={capabilities.retry}
        onDocumentOpen={() => setDocumentOpen(true)}
        initialRunId={initialRunId}
      />
    </ReactFlowProvider>
  )
}

export default function App() {
  useTheme()
  const { pathname, search } = window.location
  if (pathname === '/connections') {
    return <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading connections…</p>}><Connections /></Suspense>
  }
  // The old /watch route folds into the workspace: a session id opens that run in replay, and a
  // bare /watch opens the team list, where each team's chat holds its past work (ADR 0051).
  const params = new URLSearchParams(search)
  if (pathname === '/watch') {
    const session = params.get('session')
    const next = new URLSearchParams()
    for (const [key, value] of params) if (key !== 'session') next.set(key, value)
    if (session) next.set('run', session)
    const query = next.toString()
    window.history.replaceState({}, '', query ? `/?${query}` : '/')
    return <Editor initialRunId={session} />
  }
  return <Editor initialRunId={params.get('run')} />
}
