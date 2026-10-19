import { ArrowRight, MessageSquareWarning, Moon, Plus, Search, Sun, UserRoundPlus, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { openFeedback } from '../../lib/feedback/report'
import { relativeTime } from '../../lib/format'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { teamDisplayName, type DeletedTeam, type TeamSummary } from '../../lib/team-file/client'
import { openTeam, teamViewFor, useTeamList } from '../../lib/team-file/useTeamList'
import { useTheme } from '../../lib/theme'
import { offerTourIfFirstRun, startTour } from '../../lib/tour/store'
import { ChipDot, LoomMark, LoomWordmark } from '../ui/glyphs'
import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import type { LoomMarkState } from '../../lib/story/loomMark'
import { chatPreview, listTime } from '../../lib/chat/preview'
import { isUnread } from '../../lib/chat/seen'
import { fabricFor } from '../../lib/story/fabric'
import { TeamFabric } from './TeamFabric'
import { OpenRouterKey } from '../connections/OpenRouterKey'
import { AboutYou } from '../you/AboutYou'
import { toldNothing, useYou } from '../../lib/you/client'
import { UpdateBadge } from '../updates/Updates'
import { QuestsLink } from '../quests/QuestsLink'
import { SkillsLink } from '../skills/SkillsLink'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import { NewTeamDialog } from './NewTeamDialog'
import { TeamCardMenu } from './TeamCardMenu'
import { YourAgentsShelf } from './YourAgentsShelf'
import { keys } from '../../lib/platform'
import { dollars } from '../../lib/runs/spend'

export interface HomeProps {
  /** Something the operator must know before choosing a team, e.g. a link that did not open. */
  notice?: string | null
  onPalette: () => void
  /** Header actions owned by the workspace, e.g. the needs-you tray. */
  topActions?: ReactNode
  /** Every run the daemon knows, for each team card's run fabric. */
  runs?: readonly RunRecord[]
  /** What the header's mark says, from the same poll as the needs-you tray. */
  mark?: LoomMarkState
  /** Ask LoomWatch: describe the job and the assistant sets the team up (ADR 0033). */
  ask?: { unavailable: string | null; onAsk: (text: string) => void }
  children?: ReactNode
}

/** "Describe the job": the other way to start, for someone who would rather say than build. */
function DescribeTheJob({ unavailable, onAsk }: { unavailable: string | null; onAsk: (text: string) => void }) {
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim() || unavailable) return
    onAsk(text.trim())
    setText('')
  }
  return (
    <>
      <form className="home-ask" data-tour="ask" onSubmit={(event) => { event.preventDefault(); send() }}>
        <label>
          <span>Or describe the job</span>
          <textarea
            rows={1}
            value={text}
            maxLength={8000}
            disabled={Boolean(unavailable)}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}
            placeholder="Every weekday at 8, brief me on AI and chip news"
          />
        </label>
        <button type="submit" className="btn" disabled={!text.trim() || Boolean(unavailable)}>Ask<ArrowRight size={15} aria-hidden="true" /></button>
      </form>
      <p className="home-ask-note">{unavailable ?? 'Ask LoomWatch sets the team up on the canvas for you to check. Nothing is saved or run until you say so.'}</p>
    </>
  )
}

const PROBLEM_LABEL: Record<NonNullable<TeamSummary['problem']>, string> = {
  unreadable: 'Can’t be opened: not valid YAML',
  not_a_team: 'Can’t be opened: not a team file',
}

function describeTeam(team: TeamSummary): string {
  const parts = [team.problem ? PROBLEM_LABEL[team.problem] : team.agentCount > 0 ? `${team.agentCount} step${team.agentCount === 1 ? '' : 's'}` : 'Needs setup']
  if (team.modifiedAt) parts.push(`edited ${relativeTime(new Date(team.modifiedAt))}`)
  return parts.join(' · ')
}

/**
 * What the operator sees before any team is open: what LoomWatch is for, and the work in the order
 * it is done. First your agents (build each one and chat with it on its own), then your teams (put agents
 * in a workflow, then give the team work in its chat). One obvious way to start: build an agent.
 */
export function Home({ notice = null, onPalette, topActions, runs = [], mark, ask, children }: HomeProps) {
  const { resolved, toggle } = useTheme()
  const { teams, trashed, error, retry: retryTeams, forget } = useTeamList()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<TeamSummary | null>(null)
  const [deleted, setDeleted] = useState<DeletedTeam | null>(null)
  const [query, setQuery] = useState('')
  const key = useKeyStatus()
  // The key card stays until the key is in, and for the moment after, so the person sees that
  // OpenRouter accepted it before the card makes way.
  const [keyCard, setKeyCard] = useState(false)
  if (key && !key.connected && !keyCard) setKeyCard(true)
  // Then, once a key is in, what agents should know about the person (ADR 0074): asked once, and
  // kept on screen after Save so they see it was kept. Not now puts it away for good.
  const you = useYou()
  const [youCard, setYouCard] = useState<'offered' | 'gone' | null>(null)
  if (youCard === null && key?.connected && you && !you.skipped && toldNothing(you)) setYouCard('offered')
  // Teams are listed as chats (ADR 0051): the one with the newest work first, then the rest.
  const previews = useMemo(() => new Map((teams ?? []).map((team) => [team.path, chatPreview(runs, team.path)])), [teams, runs])
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = !teams ? [] : !needle ? teams : teams.filter((team) => teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
    const at = (path: string) => previews.get(path)?.at ?? ''
    return [...matching].sort((left, right) => at(right.path).localeCompare(at(left.path)))
  }, [teams, query, previews])

  // Someone who has never run a team is offered the getting-started guide, once per browser; see
  // lib/tour/store.ts. Asked once per visit to Home, not on every refresh of the team list.
  const tourChecked = useRef(false)
  useEffect(() => {
    if (!teams || tourChecked.current) return
    tourChecked.current = true
    void offerTourIfFirstRun(teams.length, fetchRuns)
  }, [teams])

  // ⌘N / the palette's "New team…" reach the dialog through this event, so Home owns its state.
  useEffect(() => {
    const open = () => setCreating(true)
    window.addEventListener('loomwatch:new-team', open)
    return () => window.removeEventListener('loomwatch:new-team', open)
  }, [])

  // What the footer says about the one thing every run needs: the OpenRouter key.
  let status: { state: 'dirty' | 'saved' | 'incomplete' | 'invalid'; text: string; action?: ReactNode }
  const manage = <a className="link" href="/connections">{key?.connected ? 'Manage key' : 'Add a key'}</a>
  if (!key) status = { state: 'dirty', text: 'Checking your OpenRouter key…' }
  else if (!key.connected) status = { state: 'incomplete', text: 'Add your OpenRouter key so your agents can run.', action: keyCard ? undefined : manage }
  else if (key.problem) status = { state: 'invalid', text: `OpenRouter: ${key.problem}`, action: manage }
  else if (key.freeTier) status = { state: 'incomplete', text: 'Your OpenRouter account has no credits yet, so only free models work.', action: manage }
  else status = { state: 'saved', text: `Agents run on OpenRouter${key.label ? ` with key ${key.label}` : ''}${key.spentThisMonth === undefined ? '' : ` · ${dollars(key.spentThisMonth)} this month`}`, action: manage }

  return (
    <div className="lw-home" data-tour="home">
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <span className="home-brand"><LoomMark size={28} state={mark} /><LoomWordmark height={19} /></span>
        <span className="home-top-acts">
          {topActions}
          <UpdateBadge />
          <SkillsLink />
          <QuestsLink />
          <button type="button" className="home-feedback" onClick={() => openFeedback({ screen: 'home' })} aria-label="Send feedback" title="Report a problem or share an idea"><MessageSquareWarning size={15} aria-hidden="true" /><span className="home-feedback-label">Feedback</span></button>
          <button type="button" className="iconbtn" onClick={onPalette} aria-label="Open the command palette" title={`Commands (${keys('⌘K')})`}><Search size={15} aria-hidden="true" /></button>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={`Theme (${keys('⌘⇧L')})`}>{resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}</button>
        </span>
      </header>

      <main className="home-main">
        {notice && <p role="alert" className="home-empty alert">{notice}</p>}
        <section className="home-hero">
          <h1 className="t-display">Put AI agents to work as a team.</h1>
          <p>Build each agent and chat with it on its own, connect your agents in a workflow, then give the team work in its chat and review what it hands back.</p>
          <div className="home-hero-acts">
            <a className="btn btn-primary btn-lg" href="/agents/new" data-tour="build-agent"><UserRoundPlus size={16} aria-hidden="true" />Build an agent</a>
            <button type="button" className="btn btn-lg" data-tour="new-team" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New team</button>
            <button type="button" className="link home-tour" onClick={startTour}>New here? Take the 3-minute guide</button>
          </div>
          {ask && <DescribeTheJob unavailable={ask.unavailable} onAsk={ask.onAsk} />}
          <ol className="home-steps" aria-label="How it works">
            <li><b>1</b><span><strong>Agents.</strong> Build each agent and chat with it on its own.</span></li>
            <li><b>2</b><span><strong>Workflow.</strong> Put agents in a team and connect who hands work to whom.</span></li>
            <li><b>3</b><span><strong>Chat.</strong> Give the team work, and review each step and the result.</span></li>
          </ol>
        </section>

        {keyCard && <div className="home-key" data-tour="key"><OpenRouterKey variant="card" /></div>}
        {youCard === 'offered' && <div className="home-key">
          <AboutYou variant="card" onDone={(kept) => { if (toldNothing(kept)) setYouCard('gone') }} />
        </div>}

        {/* In the order the work is done: agents first, then the teams they work in. */}
        <YourAgentsShelf />

        <section className="home-teams" aria-labelledby="home-teams-title">
          <div className="home-teams-head">
            <h2 id="home-teams-title">Your teams<span className="home-section-says">Workflows and chats</span></h2>
            {teams && teams.length > 6 && (
              <label className="home-filter"><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a team" aria-label="Find a team" /></label>
            )}
          </div>
          {/* The card leaving is the confirmation; only a screen reader hears it said. */}
          {deleted && <p role="status" className="visually-hidden">Deleted “{deleted.name ?? teamDisplayName(deleted)}”.</p>}
          {error && <p role="alert" className="home-empty alert">Couldn't list your teams. {error} <button type="button" className="link" onClick={retryTeams}>Try again</button></p>}
          {!error && teams === null && <p role="status" className="home-empty">Loading your teams…</p>}
          {!error && teams?.length === 0 && (
            <div className="home-empty">
              <Users size={20} aria-hidden="true" />
              <span>No teams yet. When your agents are ready, put them in a team: <button type="button" className="link" onClick={() => setCreating(true)}>Create one</button></span>
            </div>
          )}
          {shown.length > 0 && (
            <ul className="home-grid">
              {shown.map((team, index) => {
                const fabric = fabricFor(runs, team.path)
                const preview = previews.get(team.path) ?? null
                const unread = preview ? isUnread(team.path, preview.at) : false
                return (
                <li key={team.path} style={{ ['--card-i' as string]: index }}>
                  <button type="button" className={`home-card ${fabric.waiting ? 'waiting' : ''}${unread ? ' unread' : ''}`} onClick={() => openTeam(team.path, teamViewFor(team, Boolean(preview)))}>
                    <span className="home-card-name"><span className="home-card-title" title={teamDisplayName(team)}>{teamDisplayName(team)}</span>{fabric.waiting && <em className="home-card-waiting">Waiting for you</em>}{unread && <i className="home-card-unread" aria-label="New since you looked" />}</span>
                    {preview && (
                      <span className="home-card-chat"><span className="home-card-line">{preview.line}</span><time dateTime={preview.at}>{listTime(preview.at)}</time></span>
                    )}
                    <span className="home-card-meta">{describeTeam(team)}</span>
                    <TeamFabric fabric={fabric} />
                    <span className="home-card-file t-mono-sm">{team.path}</span>
                    <ArrowRight className="home-card-go" size={16} aria-hidden="true" />
                  </button>
                  <TeamCardMenu name={teamDisplayName(team)} onDelete={() => setDeleting(team)} />
                </li>
                )
              })}
            </ul>
          )}
          {teams && teams.length > 0 && query && shown.length === 0 && <p className="home-empty">No team matches “{query}”.</p>}
        </section>
      </main>

      <footer className="home-foot t-meta" role="status">
        <ChipDot state={status.state} size={10} />
        <span>{status.text}</span>
        {status.action}
      </footer>

      {creating && (
        <NewTeamDialog
          existingPaths={[...(teams?.map((team) => team.path) ?? []), ...trashed]}
          onClose={() => setCreating(false)}
        />
      )}
      {deleting && (
        <DeleteTeamDialog
          path={deleting.path}
          name={teamDisplayName(deleting)}
          onDeleted={(result) => { forget(result.path); setDeleted(result); setDeleting(null) }}
          onClose={() => setDeleting(null)}
        />
      )}
      {children}
    </div>
  )
}
