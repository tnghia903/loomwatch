import { ArrowRight, MessageSquareWarning, Moon, Plus, Search, Sun, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { openFeedback } from '../../lib/feedback/report'
import { relativeTime } from '../../lib/format'
import { fetchHarnessModels, harnessProblem, isHarnessRunnable, type DetectedHarness } from '../../lib/harnesses'
import { teamDisplayName, type DeletedTeam, type TeamSummary } from '../../lib/team-file/client'
import { openTeam, useTeamList } from '../../lib/team-file/useTeamList'
import { useTheme } from '../../lib/theme'
import { offerTourIfFirstRun, startTour } from '../../lib/tour/store'
import { ChipDot, LoomMark } from '../ui/glyphs'
import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import { fabricFor } from '../../lib/story/fabric'
import { TeamFabric } from './TeamFabric'
import { DeleteTeamDialog } from './DeleteTeamDialog'
import { NewTeamDialog } from './NewTeamDialog'
import { TeamCardMenu } from './TeamCardMenu'

export interface HomeProps {
  /** Something the operator must know before choosing a team, e.g. a link that did not open. */
  notice?: string | null
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  harnessesError: string | null
  onRetryHarnesses: () => void
  /** Open an unsaved, empty team at `path` (the "Empty team" choice). */
  onCreateBlank: (name: string, path: string) => void
  onPalette: () => void
  /** Header actions owned by the workspace, e.g. the needs-you tray. */
  topActions?: ReactNode
  /** Every run the daemon knows, for each team card's run fabric. */
  runs?: readonly RunRecord[]
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
 * What the operator sees before any team is open: what LoomWatch is for, their teams by name, and
 * one obvious way to start. It replaces a screen whose only paths were "New team" and a dialog
 * that asked for a YAML path relative to the daemon's teams directory.
 */
export function Home({ notice = null, harnesses, harnessesLoading, harnessesError, onRetryHarnesses, onCreateBlank, onPalette, topActions, runs = [], ask, children }: HomeProps) {
  const { resolved, toggle } = useTheme()
  const { teams, trashed, error, retry: retryTeams, forget } = useTeamList()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<TeamSummary | null>(null)
  const [deleted, setDeleted] = useState<DeletedTeam | null>(null)
  const [query, setQuery] = useState('')
  const [rechecking, setRechecking] = useState(false)
  const runnable = harnesses.filter(isHarnessRunnable)
  // Installed and ACP-capable, but the daemon's last attempt to start it failed. An app with no ACP
  // bridge at all (`acpAvailable: false`) is the Library's to explain, not the first-run footer's.
  const failing = harnesses.filter((harness) => harness.acpAvailable !== false && harness.health === 'error')
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!teams || !needle) return teams ?? []
    return teams.filter((team) => teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
  }, [teams, query])

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

  // The list itself never starts an app, so "Check again" for a failing one has to: asking for its
  // models is the same check the daemon's verdict came from, and it records the new answer.
  async function recheck() {
    setRechecking(true)
    await Promise.allSettled(failing.map((harness) => fetchHarnessModels(harness.id)))
    setRechecking(false)
    onRetryHarnesses()
  }
  const recheckAction = <button type="button" className="link" onClick={() => void recheck()} disabled={rechecking}>{rechecking ? 'Checking…' : 'Check again'}</button>

  let status: { state: 'dirty' | 'saved' | 'incomplete' | 'invalid'; text: string; action?: ReactNode }
  if (harnessesLoading) status = { state: 'dirty', text: 'Looking for AI apps on this computer…' }
  else if (harnessesError) status = { state: 'invalid', text: `Couldn't check which AI apps are installed: ${harnessesError}`, action: <button type="button" className="link" onClick={onRetryHarnesses}>Try again</button> }
  else if (runnable.length === 0 && failing.length > 0) status = { state: 'incomplete', text: 'None of your AI apps can start right now.', action: recheckAction }
  else if (runnable.length === 0) status = { state: 'incomplete', text: 'No AI apps found. Install Claude Code, Codex or OpenCode, sign in, then try again.', action: <button type="button" className="link" onClick={onRetryHarnesses}>Check again</button> }
  else status = { state: 'saved', text: `Ready to use: ${runnable.map((harness) => harness.name).join(', ')}`, ...(failing.length > 0 ? { action: recheckAction } : {}) }
  const problems = harnessesLoading || harnessesError ? [] : failing

  return (
    <div className="lw-home" data-tour="home">
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <span className="home-brand"><LoomMark width={46} height={20} /><span>LoomWatch</span></span>
        <span className="home-top-acts">
          {topActions}
          <button type="button" className="home-feedback" onClick={() => openFeedback({ screen: 'home' })} aria-label="Send feedback" title="Report a problem or share an idea"><MessageSquareWarning size={15} aria-hidden="true" /><span className="home-feedback-label">Feedback</span></button>
          <button type="button" className="iconbtn" onClick={onPalette} aria-label="Open the command palette" title="Commands (⌘K)"><Search size={15} aria-hidden="true" /></button>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme (⌘⇧L)">{resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}</button>
        </span>
      </header>

      <main className="home-main">
        {notice && <p role="alert" className="home-empty alert">{notice}</p>}
        <section className="home-hero">
          <h1 className="t-display">Put AI agents to work as a team.</h1>
          <p>Give your team a task, watch each step as it happens, and review the result before you use it.</p>
          <div className="home-hero-acts">
            <button type="button" className="btn btn-primary btn-lg" data-tour="new-team" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New team</button>
            <button type="button" className="link home-tour" onClick={startTour}>New here? Take the 3-minute guide</button>
          </div>
          {ask && <DescribeTheJob unavailable={ask.unavailable} onAsk={ask.onAsk} />}
          <ol className="home-steps" aria-label="How it works">
            <li><b>1</b><span><strong>Build</strong> a team from the AI apps on this computer.</span></li>
            <li><b>2</b><span><strong>Ask</strong> it to do something, in plain words.</span></li>
            <li><b>3</b><span><strong>Review</strong> each step and the final result.</span></li>
          </ol>
        </section>

        <section className="home-teams" aria-labelledby="home-teams-title">
          <div className="home-teams-head">
            <h2 id="home-teams-title">Your teams</h2>
            {teams && teams.length > 6 && (
              <label className="home-filter"><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a team" aria-label="Find a team" /></label>
            )}
          </div>
          {deleted && <p role="status" className="home-empty">Deleted “{deleted.name ?? teamDisplayName(deleted)}”. Its files are in <code>{deleted.trash}</code> inside your teams folder.</p>}
          {error && <p role="alert" className="home-empty alert">Couldn't list your teams. {error} <button type="button" className="link" onClick={retryTeams}>Try again</button></p>}
          {!error && teams === null && <p role="status" className="home-empty">Loading your teams…</p>}
          {!error && teams?.length === 0 && (
            <div className="home-empty">
              <Users size={20} aria-hidden="true" />
              <span>No teams yet. Create one to get started — it takes a few seconds.</span>
            </div>
          )}
          {shown.length > 0 && (
            <ul className="home-grid">
              {shown.map((team, index) => {
                const fabric = fabricFor(runs, team.path)
                return (
                <li key={team.path} style={{ ['--card-i' as string]: index }}>
                  <button type="button" className={`home-card ${fabric.waiting ? 'waiting' : ''}`} onClick={() => openTeam(team.path)}>
                    <span className="home-card-name">{teamDisplayName(team)}{fabric.waiting && <em className="home-card-waiting">Waiting for you</em>}</span>
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
        <span data-tour="apps">{status.text}</span>
        {status.action}
        {problems.length > 0 && (
          <ul className="home-foot-problems" aria-label="Apps that need attention">
            {problems.map((harness) => <li key={harness.id} title={harness.healthDetail}>{harnessProblem(harness)}</li>)}
          </ul>
        )}
      </footer>

      {creating && (
        <NewTeamDialog
          harnesses={harnesses}
          existingPaths={[...(teams?.map((team) => team.path) ?? []), ...trashed]}
          onCreateBlank={onCreateBlank}
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
