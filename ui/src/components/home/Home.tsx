import { Search } from '../ui/icon'
import { useEffect, useState, type ReactNode } from 'react'

import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { SOURCE_INFO, connectedSources } from '../../lib/ai/sources'
import { fetchTeamsDiscovery } from '../../lib/team-file/client'
import { markFirstRun, opensOnFirstRun, readFirstRun } from '../../lib/firstrun/store'
import { fetchJobs } from '../../lib/library/jobs'
import { FirstRun } from '../firstrun/FirstRun'
import { ChipDot } from '../ui/glyphs'
import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import { Sources } from '../connections/Sources'
import { UsageNotices } from '../usage/UsageNotices'
import { UpdateBadge } from '../updates/Updates'
import { keys } from '../../lib/platform'
import { dollars } from '../../lib/runs/spend'
import { Studio } from '../studio/Studio'
import { setUpRequest } from '../studio/setUpRequest'

export interface HomeProps {
  /** Something the operator must know before choosing a team, e.g. a link that did not open. */
  notice?: string | null
  onPalette: () => void
  /** Header actions owned by the workspace, e.g. the needs-you tray. */
  topActions?: ReactNode
  /** Every run the daemon knows, for each team card's run fabric. */
  runs?: readonly RunRecord[]
  /** Ask LoomWatch, which sets a project up from what you are working on (ADR 0097). */
  ask?: { unavailable: string | null; onAsk: (text: string) => void; open?: boolean }
  /** Home, or the dock's Projects: the same studio with only its projects and agents in none. */
  part?: 'all' | 'projects'
  children?: ReactNode
}

/**
 * What the operator sees before any team is open: the studio (ADR 0097). Your desk at a glance
 * (what needs you, who is working, what finished today, this month) with a box to give any team
 * work, where you left off, each project as a room, and your agents in no project; or, before any
 * project, what you are working on.
 */
export function Home({ notice = null, onPalette, topActions, runs = [], ask, part = 'all', children }: HomeProps) {
  const ai = useAiStatus()
  const key = ai?.openrouter ?? null
  const sources = ai ? connectedSources(ai) : []
  // The three cards stay until a way to pay for models is in, and for the moment after, so the
  // person sees it accepted before the cards make way (ADR 0073).
  const [keyCard, setKeyCard] = useState(false)
  if (ai && sources.length === 0 && !keyCard) setKeyCard(true)
  // Someone who has never had anything made in this LoomWatch opens on the first run (ADR 0075),
  // instead of this page; see lib/firstrun/store.ts. Asked once per visit. It replaces the
  // getting-started guide opening by itself, which stays a link here and in the menu.
  const [firstRun, setFirstRun] = useState<'checking' | 'on' | 'off'>(() => (part === 'projects' || readFirstRun() ? 'off' : 'checking'))
  useEffect(() => {
    if (firstRun !== 'checking') return
    let live = true
    void opensOnFirstRun({ listRuns: fetchRuns, listAgents: fetchJobs, listTeams: fetchTeamsDiscovery }).then((on) => { if (live) setFirstRun(on ? 'on' : 'off') })
    return () => { live = false }
  }, [firstRun])
  // ⌘N / the palette's "New team…": every team works in a project, so on Home it starts one.
  useEffect(() => {
    const open = () => window.dispatchEvent(new Event('loomwatch:new-project'))
    window.addEventListener('loomwatch:new-team', open)
    return () => window.removeEventListener('loomwatch:new-team', open)
  }, [])

  if (firstRun === 'on') {
    return <FirstRun onLookAround={() => { markFirstRun('skipped'); setFirstRun('off') }} onDone={() => setFirstRun('off')} />
  }

  // What the footer says about the one thing every run needs: a way to pay for its models.
  let status: { state: 'dirty' | 'saved' | 'incomplete' | 'invalid'; text: string; action?: ReactNode }
  const manage = <a className="link" href="/connections">{sources.length ? 'Connections' : 'Connect'}</a>
  const usage = <a className="link" href="/usage">Usage</a>
  // A connected source that said something is wrong, named, so the person knows which to fix.
  const problem = ai && [
    ai.chatgpt.connected && ai.chatgpt.problem ? `ChatGPT: ${ai.chatgpt.problem}` : undefined,
    ai.anthropic.connected && ai.anthropic.problem ? `Claude: ${ai.anthropic.problem}` : undefined,
    key?.connected && key.problem ? `OpenRouter: ${key.problem}` : undefined,
  ].find(Boolean)
  if (!ai || !key) status = { state: 'dirty', text: 'Checking how your agents’ models are paid…' }
  else if (sources.length === 0) status = { state: 'incomplete', text: 'Connect your ChatGPT plan, your Claude API credit or an OpenRouter key so your agents can run.', action: keyCard ? undefined : manage }
  else if (problem) status = { state: 'invalid', text: problem, action: manage }
  else if (sources.length === 1 && key.connected && key.freeTier) status = { state: 'incomplete', text: 'Your OpenRouter account has no credits yet, so only free models work.', action: manage }
  else {
    const spent = key.connected && key.spentThisMonth !== undefined ? ` · OpenRouter ${dollars(key.spentThisMonth)} this month` : ''
    status = { state: 'saved', text: `Agents can run on ${sources.map((source) => SOURCE_INFO[source].chip).join(', ')}${spent}`, action: <>{usage}{manage}</> }
  }

  return (
    // Unseen while it is asked whether this is a first run, so a newcomer's first screen is the first
    // run, not Home for a moment before it. home.css shows it after a second whatever the answer.
    <div className="lw-home" data-tour="home" data-checking={firstRun === 'checking' || undefined}>
      <div className="ground" aria-hidden="true" />
      {/* The places are the dock's, and the look, the guide and feedback are in You: Home's corner
          keeps the update, the bell and search. */}
      <header className="home-top">
        <span className="home-top-acts">
          <UpdateBadge />
          {topActions}
          <button type="button" className="iconbtn" onClick={onPalette} aria-label="Open the command palette" title={`Commands (${keys('⌘K')})`}><Search size={15} aria-hidden="true" /></button>
        </span>
      </header>

      <main className="home-main">
        {notice && <p role="alert" className="home-empty alert">{notice}</p>}

        {keyCard && <div className="home-key" data-tour="key"><Sources title="First, choose how your agents’ models are paid" fill={false} /></div>}

        <UsageNotices />

        <Studio
          part={part}
          runs={runs}
          setUpUnavailable={ask ? ask.unavailable : 'Ask LoomWatch isn’t available here.'}
          asking={ask?.open === true}
          onSetUp={(start) => ask?.onAsk(setUpRequest(start))}
        />
      </main>

      <footer className="home-foot t-meta" role="status">
        <ChipDot state={status.state} size={10} />
        <span>{status.text}</span>
        {status.action}
      </footer>

      {children}
    </div>
  )
}
