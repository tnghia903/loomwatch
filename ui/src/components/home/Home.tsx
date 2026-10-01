import { ArrowRight, Moon, Plus, Search, Sun, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { relativeTime } from '../../lib/format'
import type { DetectedHarness } from '../../lib/harnesses'
import { teamDisplayName, type TeamSummary } from '../../lib/team-file/client'
import { openTeam, useTeamList } from '../../lib/team-file/useTeamList'
import { useTheme } from '../../lib/theme'
import { ChipDot, LoomMark } from '../ui/glyphs'
import { NewTeamDialog } from './NewTeamDialog'

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
  children?: ReactNode
}

function describeTeam(team: TeamSummary): string {
  const parts = [team.agentCount > 0 ? `${team.agentCount} step${team.agentCount === 1 ? '' : 's'}` : 'Needs setup']
  if (team.modifiedAt) parts.push(`edited ${relativeTime(new Date(team.modifiedAt))}`)
  return parts.join(' · ')
}

/**
 * What the operator sees before any team is open: what LoomWatch is for, their teams by name, and
 * one obvious way to start. It replaces a screen whose only paths were "New team" and a dialog
 * that asked for a YAML path relative to the daemon's teams directory.
 */
export function Home({ notice = null, harnesses, harnessesLoading, harnessesError, onRetryHarnesses, onCreateBlank, onPalette, children }: HomeProps) {
  const { resolved, toggle } = useTheme()
  const { teams, error } = useTeamList()
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const runnable = harnesses.filter((harness) => harness.acpAvailable !== false)
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!teams || !needle) return teams ?? []
    return teams.filter((team) => teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
  }, [teams, query])

  // ⌘N / the palette's "New team…" reach the dialog through this event, so Home owns its state.
  useEffect(() => {
    const open = () => setCreating(true)
    window.addEventListener('loomwatch:new-team', open)
    return () => window.removeEventListener('loomwatch:new-team', open)
  }, [])

  let status: { state: 'dirty' | 'saved' | 'incomplete' | 'invalid'; text: string; action?: ReactNode }
  if (harnessesLoading) status = { state: 'dirty', text: 'Looking for AI apps on this computer…' }
  else if (harnessesError) status = { state: 'invalid', text: `Couldn't check which AI apps are installed: ${harnessesError}`, action: <button type="button" className="link" onClick={onRetryHarnesses}>Try again</button> }
  else if (runnable.length === 0) status = { state: 'incomplete', text: 'No AI apps found. Install Claude Code, Codex or OpenCode, sign in, then try again.', action: <button type="button" className="link" onClick={onRetryHarnesses}>Check again</button> }
  else status = { state: 'saved', text: `Ready to use: ${runnable.map((harness) => harness.name).join(', ')}` }

  return (
    <div className="lw-home">
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <span className="home-brand"><LoomMark width={46} height={20} /><span>LoomWatch</span></span>
        <span className="home-top-acts">
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
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New team</button>
          </div>
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
          {error && <p role="alert" className="home-empty alert">Couldn't list your teams: {error}</p>}
          {!error && teams === null && <p role="status" className="home-empty">Loading your teams…</p>}
          {!error && teams?.length === 0 && (
            <div className="home-empty">
              <Users size={20} aria-hidden="true" />
              <span>No teams yet. Create one to get started — it takes a few seconds.</span>
            </div>
          )}
          {shown.length > 0 && (
            <ul className="home-grid">
              {shown.map((team) => (
                <li key={team.path}>
                  <button type="button" className="home-card" onClick={() => openTeam(team.path)}>
                    <span className="home-card-name">{teamDisplayName(team)}</span>
                    <span className="home-card-meta">{describeTeam(team)}</span>
                    <span className="home-card-file t-mono-sm">{team.path}</span>
                    <ArrowRight className="home-card-go" size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
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
          harnesses={harnesses}
          existingPaths={teams?.map((team) => team.path) ?? []}
          onCreateBlank={onCreateBlank}
          onClose={() => setCreating(false)}
        />
      )}
      {children}
    </div>
  )
}
