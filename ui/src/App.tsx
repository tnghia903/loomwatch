import { ReactFlowProvider } from '@xyflow/react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'

import { Feedback } from './components/feedback/Feedback'
import { Updates } from './components/updates/Updates'
import { GettingStarted } from './components/tour/GettingStarted'
import { Workspace } from './components/Workspace'
import { NeedsYouTray } from './components/workspace/NeedsYouTray'
import { useAiStatus } from './lib/ai/useKeyStatus'
import { connectedSources } from './lib/ai/sources'
import { fetchCapabilities, SKILLS_CHANGED_EVENT, type CapabilityInventory } from './lib/library/client'
import { useNeedsYou } from './lib/story/useNeedsYou'
import { useTheme } from './lib/theme'

const Connections = lazy(() => import('./components/Connections'))
const AboutYouPage = lazy(() => import('./components/you/AboutYouPage'))
const AgentsPage = lazy(() => import('./components/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })))
const QuestsPage = lazy(() => import('./components/quests/QuestsPage').then((module) => ({ default: module.QuestsPage })))
const SkillsPage = lazy(() => import('./components/skills/SkillsPage').then((module) => ({ default: module.SkillsPage })))
const UsagePage = lazy(() => import('./components/usage/UsagePage').then((module) => ({ default: module.UsagePage })))

function useCapabilities() {
  const [inventory, setInventory] = useState<CapabilityInventory>({ skills: [], sources: [] })
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
  // Skills added or taken away (the marketplace over the builder): read again, without "Looking…".
  useEffect(() => {
    const reread = () => setGeneration((value) => value + 1)
    window.addEventListener(SKILLS_CHANGED_EVENT, reread)
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, reread)
  }, [])
  const retry = useCallback(() => { setLoading(true); setGeneration((value) => value + 1) }, [])
  return { inventory, loading, error, scannedAt, retry }
}

/** The guide waits for a way to pay for models before it asks for an agent. */
function Guide() {
  const ai = useAiStatus()
  return <GettingStarted keyReady={ai !== null && connectedSources(ai).length > 0} keyLoading={ai === null} />
}

function Editor({ initialRunId }: { initialRunId: string | null }) {
  const capabilities = useCapabilities()
  const [, setDocumentOpen] = useState(() => new URLSearchParams(window.location.search).has('path'))
  return (
    <ReactFlowProvider>
      {/* Above Home and the workspace alike: the guide carries on across the page load a new team causes. */}
      <Guide />
      <Feedback />
      <Updates />
      <Workspace
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

/** Your agents (`/agents`): build and try one agent at a time, then use it in any team. */
function Agents() {
  const capabilities = useCapabilities()
  // The same poll as the workspace's, so the header's mark, the tab icon and the rail's figures say the same here.
  const needsYou = useNeedsYou()
  // The bell an agent's header has, as a team's does: answer what waits on you from here.
  const tray = <NeedsYouTray tickets={needsYou.tickets} working={needsYou.working} onAnswer={needsYou.answer} onPermission={needsYou.answerPermission} onSpend={needsYou.answerSpend} onDismiss={needsYou.dismiss} />
  return (
    <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading your agents…</p>}>
      {/* The guide starts with building an agent, here, then carries on at Home and in a team. */}
      <Guide />
      <Feedback />
      <AgentsPage skills={capabilities.inventory.skills} skillsLoading={capabilities.loading} mark={needsYou.mark} records={needsYou.records} tray={tray} />
    </Suspense>
  )
}

/** Skills (`/skills`): LoomWatch's own skills folder, bring-in and the marketplace. */
function Skills() {
  const { mark } = useNeedsYou()
  return <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading skills…</p>}><SkillsPage mark={mark} /></Suspense>
}

/** Quests (`/quests`), with the header's mark on the same poll as everywhere else. */
function Quests() {
  const { mark } = useNeedsYou()
  return <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading quests…</p>}><QuestsPage mark={mark} /></Suspense>
}

export default function App() {
  useTheme()
  const { pathname, search } = window.location
  if (pathname === '/agents' || pathname.startsWith('/agents/')) return <Agents />
  if (pathname === '/quests') return <Quests />
  if (pathname === '/skills') return <Skills />
  if (pathname === '/usage') {
    return <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading usage…</p>}><UsagePage /></Suspense>
  }
  if (pathname === '/connections') {
    return <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading connections…</p>}><Connections /></Suspense>
  }
  if (pathname === '/you') {
    return <Suspense fallback={<p className="t-meta" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Loading…</p>}><AboutYouPage /></Suspense>
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
