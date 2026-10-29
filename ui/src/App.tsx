import { ReactFlowProvider } from '@xyflow/react'
import { Suspense, useCallback, useEffect, useState } from 'react'

import { AgentsPage } from './components/agents/AgentsPage'
import Connections from './components/Connections'
import { Feedback } from './components/feedback/Feedback'
import { QuestsPage } from './components/quests/QuestsPage'
import { SkillsPage } from './components/skills/SkillsPage'
import { UsagePage } from './components/usage/UsagePage'
import AboutYouPage from './components/you/AboutYouPage'
import { Updates } from './components/updates/Updates'
import { GettingStarted } from './components/tour/GettingStarted'
import { Workspace } from './components/Workspace'
import { AppFrame } from './components/frame/AppFrame'
import { NeedsYouTray } from './components/workspace/NeedsYouTray'
import { useAiStatus } from './lib/ai/useKeyStatus'
import { connectedSources } from './lib/ai/sources'
import { fetchCapabilities, SKILLS_CHANGED_EVENT, type CapabilityInventory } from './lib/library/client'
import { useNeedsYou } from './lib/story/useNeedsYou'
import { useMoveOntoMyAgents } from './lib/team-file/moveOntoMyAgents'
import { useMoveIntoProjects } from './lib/projects/move'
import { ProjectRoom } from './components/studio/ProjectRoom'
import { useTeamPage } from './lib/team-file/teamPage'
import { useTheme } from './lib/theme'

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

function Editor() {
  const capabilities = useCapabilities()
  const [, setDocumentOpen] = useState(() => new URLSearchParams(window.location.search).has('path'))
  // Another team opens in place (lib/team-file/teamPage.ts): the frame stays, and the
  // team's own part, canvas included, starts fresh under a new key, as on a page load.
  const page = useTeamPage()
  return (
    <>
      {/* Above Home and the workspace alike: the guide carries on across the page load a new team causes. */}
      <Guide />
      <Feedback />
      <Updates />
      <ReactFlowProvider key={page.key}>
        <Workspace
          capabilityInventory={capabilities.inventory}
          capabilitiesLoading={capabilities.loading}
          capabilitiesError={capabilities.error}
          capabilitiesScannedAt={capabilities.scannedAt}
          onRetryCapabilities={capabilities.retry}
          onDocumentOpen={() => setDocumentOpen(true)}
          initialRunId={page.runId}
        />
      </ReactFlowProvider>
    </>
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
  return <AppFrame><Screen /></AppFrame>
}

/** The screen the address asks for, inside the one frame. */
function Screen() {
  useTheme()
  // The first open after every agent became one of My agents moves the teams there (ADR 0094).
  // Pages draw at once; only a move that is needed holds them, and they draw afresh after it.
  const move = useMoveOntoMyAgents()
  // Then every team works in a project (ADR 0097): one in none becomes a project of its own.
  const projects = useMoveIntoProjects(move === 'done')
  const { pathname, search } = window.location
  const showsTeams = pathname === '/' || pathname === '/projects' || pathname === '/watch' || pathname === '/agents' || pathname.startsWith('/agents/') || pathname.startsWith('/projects/')
  if (move === 'moving' && showsTeams) {
    return <p className="t-meta" role="status" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Adding your teams’ agents to My agents…</p>
  }
  if (projects === 'moving' && showsTeams) {
    return <p className="t-meta" role="status" style={{ padding: 32, color: 'var(--color-ink-3)' }}>Putting each team in a project…</p>
  }
  if (pathname === '/agents' || pathname.startsWith('/agents/')) return <Agents />
  // A project's room (ADR 0097): its wall, and its teams at their desks. The guide carries on here,
  // where a team is started.
  if (pathname.startsWith('/projects/')) return <><Guide /><ProjectRoom id={decodeURIComponent(pathname.slice('/projects/'.length))} /></>
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
  // bare /watch opens the team list, where each team's chat holds its past work (ADR 0051). The
  // workspace reads the run from the address.
  if (pathname === '/watch') {
    const params = new URLSearchParams(search)
    const session = params.get('session')
    const next = new URLSearchParams()
    for (const [key, value] of params) if (key !== 'session') next.set(key, value)
    if (session) next.set('run', session)
    const query = next.toString()
    window.history.replaceState({}, '', query ? `/?${query}` : '/')
  }
  return <Editor />
}
