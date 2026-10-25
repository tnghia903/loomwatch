import { ArrowRight, Plus, Search, UserRoundPlus, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { relativeTime } from '../../lib/format'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { SOURCE_INFO, connectedSources } from '../../lib/ai/sources'
import { fetchTeamsDiscovery, teamDisplayName, type DeletedTeam, type TeamSummary } from '../../lib/team-file/client'
import { openTeam, teamViewFor, useTeamList } from '../../lib/team-file/useTeamList'
import { useTheme } from '../../lib/theme'
import { startTour } from '../../lib/tour/store'
import { markFirstRun, opensOnFirstRun, readFirstRun } from '../../lib/firstrun/store'
import { fetchJobs } from '../../lib/library/jobs'
import { FirstRun } from '../firstrun/FirstRun'
import { ChipDot, LoomMark, LoomWordmark } from '../ui/glyphs'
import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import type { LoomMarkState } from '../../lib/story/loomMark'
import { chatPreview, listTime } from '../../lib/chat/preview'
import { isUnread } from '../../lib/chat/seen'
import { fabricFor } from '../../lib/story/fabric'
import { TeamFabric } from './TeamFabric'
import { Sources } from '../connections/Sources'
import { UsageNotices } from '../usage/UsageNotices'
import { UpdateBadge } from '../updates/Updates'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import { NewTeamDialog } from './NewTeamDialog'
import { TeamCardMenu } from './TeamCardMenu'
import { YourAgentsShelf } from './YourAgentsShelf'
import { WorkspaceMenu } from '../workspace/WorkspaceMenu'
import { QuestsLink } from '../quests/QuestsLink'
import { SkillsLink } from '../skills/SkillsLink'
import { keys } from '../../lib/platform'
import { dollars } from '../../lib/runs/spend'
import { InlineMarkdown } from '../ui/Markdown'

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
  const [firstRun, setFirstRun] = useState<'checking' | 'on' | 'off'>(() => (readFirstRun() ? 'off' : 'checking'))
  useEffect(() => {
    if (firstRun !== 'checking') return
    let live = true
    void opensOnFirstRun({ listRuns: fetchRuns, listAgents: fetchJobs, listTeams: fetchTeamsDiscovery }).then((on) => { if (live) setFirstRun(on ? 'on' : 'off') })
    return () => { live = false }
  }, [firstRun])
  // Teams are listed as chats (ADR 0051): the one with the newest work first, then the rest.
  const previews = useMemo(() => new Map((teams ?? []).map((team) => [team.path, chatPreview(runs, team.path)])), [teams, runs])
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = !teams ? [] : !needle ? teams : teams.filter((team) => teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
    const at = (path: string) => previews.get(path)?.at ?? ''
    return [...matching].sort((left, right) => at(right.path).localeCompare(at(left.path)))
  }, [teams, query, previews])

  // ⌘N / the palette's "New team…" reach the dialog through this event, so Home owns its state.
  useEffect(() => {
    const open = () => setCreating(true)
    window.addEventListener('loomwatch:new-team', open)
    return () => window.removeEventListener('loomwatch:new-team', open)
  }, [])

  if (firstRun === 'on') {
    return <FirstRun onLookAround={() => { markFirstRun('skipped'); setFirstRun('off') }} onDone={() => setFirstRun('off')} />
  }

  // What the footer says about the one thing every run needs: a way to pay for its models.
  let status: { state: 'dirty' | 'saved' | 'incomplete' | 'invalid'; text: string; action?: ReactNode }
  const manage = <a className="link" href="/connections">{sources.length ? 'Manage' : 'Connect'}</a>
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
      <header className="home-top">
        <span className="home-brand"><LoomMark size={28} state={mark} /><LoomWordmark height={19} /></span>
        <span className="home-top-acts">
          <button type="button" className="iconbtn" onClick={onPalette} aria-label="Open the command palette" title={`Commands (${keys('⌘K')})`}><Search size={15} aria-hidden="true" /></button>
          <UpdateBadge />
          {/* Skills and Quests are Home's own: what every agent can be taught, and what runs earn.
              A team's and an agent's page reach them from the menu. */}
          <SkillsLink />
          <QuestsLink />
          {/* The bell beside the menu, as on a team's and an agent's page. The theme, which a team's
              screen reaches from its palette and view bar, is in the menu. */}
          {topActions}
          <WorkspaceMenu screen="home" more={[
            { label: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: toggle },
          ]} />
        </span>
      </header>

      <main className="home-main">
        {notice && <p role="alert" className="home-empty alert">{notice}</p>}
        <section className="home-hero">
          {/* The landing page's headline, word for word and in its type: the app opens on the promise that brought you here. */}
          <h1 className="home-headline">Put AI agents to work as one team. <em>They&nbsp;improve themselves.</em></h1>
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

        {keyCard && <div className="home-key" data-tour="key"><Sources title="First, choose how your agents’ models are paid" fill={false} /></div>}

        <UsageNotices />

        {/* In the order the work is done: agents first, then the teams they work in. */}
        <YourAgentsShelf />

        <section className="home-teams" aria-labelledby="home-teams-title">
          <div className="home-teams-head">
            <h2 id="home-teams-title">My team<span className="home-section-says">Workflows and chats</span></h2>
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
              <span>No teams yet. When your agents are ready, put them in a team.</span>
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
                      <span className="home-card-chat"><span className="home-card-line">{preview.lead}{preview.words && <InlineMarkdown clickable={false}>{preview.words}</InlineMarkdown>}</span><time dateTime={preview.at}>{listTime(preview.at)}</time></span>
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
